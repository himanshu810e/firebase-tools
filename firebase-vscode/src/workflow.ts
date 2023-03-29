import * as path from "path";
import * as fs from 'fs';
import * as vscode from "vscode";
import { ExtensionContext, workspace } from "vscode";
import { FirebaseProjectMetadata } from "../../src/types/project";
import {
  writeFirebaseRCFile,
} from "./utils";
import { ExtensionBrokerImpl } from "./extension-broker";
import { deployToHosting, getUsers, listProjects, login, logoutUser, initHosting } from "./cli";
import { User } from "../../src/types/auth";
import { FirebaseRC } from "../../src/firebaserc";
import { FirebaseConfig } from "../../src/firebaseConfig";
import { currentOptions, updateOptions } from "./options";

let firebaseRC: FirebaseRC | null = null;
let firebaseJSON: FirebaseConfig | null = null;
let extensionContext: ExtensionContext = null;

function processCurrentUser(
  currentUserEmail: string,
  users: User[],
  broker: ExtensionBrokerImpl
) {
  if (!currentUserEmail && users.length > 0) {
    currentUserEmail = users[0].email;
  }
  broker.send("notifyUserChanged", currentUserEmail);
  return currentUserEmail;
}

function getRootFolders() {
  if (!workspace) {
    return [];
  }
  const folders = workspace.workspaceFolders
    ? workspace.workspaceFolders.map((wf) => wf.uri.fsPath)
    : [];
  if (workspace.workspaceFile) {
    folders.push(path.dirname(workspace.workspaceFile.fsPath));
  }
  return Array.from(new Set(folders));
}

function getJsonFile<T>(filename: string): T | null {
  const rootFolders = getRootFolders();
  for (const folder of rootFolders) {
    const rcPath = path.join(folder, filename);
    if (fs.existsSync(rcPath)) {
      const fileText = fs.readFileSync(rcPath, 'utf-8');
      try {
        const result = JSON.parse(fileText);
        currentOptions.cwd = folder;
        return result;
      } catch(e) {
        console.log(`Error parsing JSON in ${rcPath}`);
        return null;
      }
    }
  }
  return null;
}

export function setupWorkflow(
  context: ExtensionContext,
  broker: ExtensionBrokerImpl
) {
  extensionContext = context;
  let users: User[] = [];
  let currentUserEmail = "";
  // Stores a mapping from user email to list of projects for that user
  let projectsUserMapping = new Map<string, FirebaseProjectMetadata[]>();

  broker.on("getUsers", async () => {
    if (users.length === 0) {
      const accounts = await getUsers();
      users = accounts.map(account => account.user);
    }
    broker.send("notifyUsers", users);
    currentUserEmail = processCurrentUser(currentUserEmail, users, broker);
  });

  broker.on("logout", async (email: string) => {
    try {
      await logoutUser(email);
      users = [];
      broker.send("notifyUsers", users);
    } catch(e) {
      // ignored
    }
  });

  broker.on("getSelectedProject", async () => {
    // For now, just read the cached value.
    // TODO: Extend this to reading from firebaserc
    if (firebaseRC?.projects?.default) {
      broker.send("notifyProjectChanged", firebaseRC?.projects?.default);
    }
  });

  broker.on("projectPicker", async (projects: FirebaseProjectMetadata[]) => {
    const items = projects.map(({ projectId }) => projectId);
    vscode.window.showQuickPick(items).then(async (projectId) => {
      const project = projects.find((p) => p.projectId === projectId);
      if (!project) {
        vscode.window.showErrorMessage(
          "Invalid project selected. Please select a project to proceed"
        );
      } else {
        await updateFirebaseRC("default", project.projectId);
        broker.send("notifyProjectChanged", projectId);
      }
    });
  });

  broker.on("showMessage", async (msg) => {
    vscode.window.showInformationMessage(msg);
  });

  broker.on("addUser", async () => {
    const { user } = await login();
    users.push(user as User);
    if (users) {
      broker.send("notifyUsers", users);
      currentUserEmail = processCurrentUser(currentUserEmail, users, broker);
    }
  });

  broker.on("requestChangeUser", (email: string) => {
    if (users.some((user) => user.email === email)) {
      currentUserEmail = email;
      broker.send("notifyUserChanged", currentUserEmail);
    }
  });

  broker.on("getProjects", async (email) => {
    if (projectsUserMapping.has(email)) {
      console.log(`using cached projects list for ${email}`);
      const projects = projectsUserMapping.get(email)!;
      broker.send("notifyProjects", email, projects);
    } else {
      console.log(`fetching projects list for ${email}`);
      vscode.window.showQuickPick(["Loading...."]);
      const projects = (await listProjects()) as FirebaseProjectMetadata[];
      projectsUserMapping.set(email, projects);
      broker.send("notifyProjects", email, projects);
    }
  });

  broker.on(
    "selectAndInitHostingFolder",
    async (projectId: string, email: string, singleAppSupport: boolean) => {
      const options: vscode.OpenDialogOptions = {
        canSelectMany: false,
        openLabel: `Select distribution/public folder for ${projectId}`,
        canSelectFiles: false,
        canSelectFolders: true,
      };
      const fileUri = await vscode.window.showOpenDialog(options);
      if (fileUri && fileUri[0] && fileUri[0].fsPath) {
        const publicFolderFull = fileUri[0].fsPath;
        const publicFolder = publicFolderFull.substring(
          currentOptions.cwd.length + 1
        );
        await initHosting({ spa: singleAppSupport, public: publicFolder });
        broker.send("notifyHostingFolderReady", projectId, currentOptions.cwd);
      }
    }
  );

  broker.on("hostingDeploy", async () => {
    // TODO: use configuraiton saved directory with .firebaserc
    const rootFolders = getRootFolders();
    const { success, consoleUrl, hostingUrl} = await deployToHosting(firebaseJSON, firebaseRC);
    broker.send("notifyHostingDeploy", success, consoleUrl, hostingUrl);
  });

  broker.on("getWorkspaceFolders", () => {
    broker.send("notifyWorkspaceFolders", getRootFolders());
  });

  broker.on("getFirebaseJson", async () => {
    readAndSendFirebaseConfigs(broker);
  });

  context.subscriptions.push(
    setupFirebaseJsonAndRcFileSystemWatcher(context, broker)
  );
}

/**
 * Parse firebase.json and .firebaserc from the configured location, if they
 * exist, and then send it to webviews through the given broker
 */
async function readAndSendFirebaseConfigs(broker: ExtensionBrokerImpl) {
  firebaseRC = getJsonFile<FirebaseRC>('.firebaserc');
  firebaseJSON = getJsonFile<FirebaseConfig>('firebase.json');
  
  updateOptions(extensionContext, firebaseJSON, firebaseRC);
  broker.send(
    "notifyFirebaseJson",
    firebaseJSON,
    firebaseRC
  );
}

/**
 * Write new default project to .firebaserc
 */
async function updateFirebaseRC(alias: string, projectId: string) {
  if (currentOptions.cwd) {
    firebaseRC = {
      ...firebaseRC,
      projects: {
        default: firebaseRC.projects?.default || "", // ensure default no matter what
        ...(firebaseRC.projects || {}),
        [alias]: projectId,
      },
    };
    writeFirebaseRCFile(`${currentOptions.cwd}/.firebaserc`, firebaseRC);
    updateOptions(extensionContext, firebaseJSON, firebaseRC);
  }
}

/**
 * Set up a FileSystemWatcher for .firebaserc and firebase.json Also un-watch and re-watch when the
 * configuration for where in the workspace the .firebaserc and firebase.json are.
 */
function setupFirebaseJsonAndRcFileSystemWatcher(
  context: ExtensionContext,
  broker: ExtensionBrokerImpl
): vscode.Disposable {
  // Create a new watcher
  let watcher = newWatcher();

  // Return a disposable that tears down a watcher if it's active
  return {
    dispose() {
      watcher && watcher.dispose();
    },
  };

  // HelperFunction to create a new watcher
  function newWatcher() {
    if (!currentOptions.cwd) {
      return null;
    }

    let watcher = workspace.createFileSystemWatcher(
      path.join(currentOptions.cwd, "{firebase.json,.firebaserc}")
    );
    watcher.onDidChange(async () => {
      readAndSendFirebaseConfigs(broker);
    });
    return watcher;
  }
}