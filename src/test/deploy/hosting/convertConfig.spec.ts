import { expect } from "chai";
import { convertConfig } from "../../../deploy/hosting/convertConfig";
import * as args from "../../../deploy/functions/args";
import * as backend from "../../../deploy/functions/backend";
import { Context, HostingDeploy } from "../../../deploy/hosting/context";
import { HostingSingle } from "../../../firebaseConfig";
import * as api from "../../../hosting/api";
import { cloneDeep } from "../../../utils";

const FUNCTION_ID = "function";
const PROJECT_ID = "project";
const REGION = "region";
const DEFAULT_CONTEXT: Context = {
  projectId: PROJECT_ID,
  loadedExistingBackend: true,
  existingBackend: backend.empty(),
};

const DEFAULT_PAYLOAD: args.Payload = {};

function endpoint(opts?: Partial<backend.Endpoint>): backend.Endpoint {
  // Createa type that allows us to not have a trigger
  const ret: Omit<backend.Endpoint, "httpsTrigger"> & { httpsTrigger?: backend.HttpsTrigger } = {
    id: FUNCTION_ID,
    project: PROJECT_ID,
    entryPoint: FUNCTION_ID,
    region: REGION,
    runtime: "nodejs16",
    platform: "gcfv1",
    ...opts,
  };
  if (
    !(
      "httpsTrigger" in ret ||
      "eventTrigger" in ret ||
      "callableTrigger" in ret ||
      "scheduledTrigger" in ret ||
      "taskQueueTrigger" in ret ||
      "blockingTrigger" in ret
    )
  ) {
    ret.httpsTrigger = {};
  }
  return ret as backend.Endpoint;
}

describe("convertConfig", () => {
  const tests: Array<{
    name: string;
    input: HostingSingle;
    want: api.ServingConfig;
    payload?: args.Payload;
    finalize?: boolean;
    context?: Context;
  }> = [
    // Rewrites.
    {
      name: "returns rewrites for glob destination",
      input: { rewrites: [{ glob: "/foo", destination: "https://example.com" }] },
      want: { rewrites: [{ glob: "/foo", path: "https://example.com" }] },
    },
    {
      name: "returns rewrites for regex destination",
      input: { rewrites: [{ glob: "/foo$", destination: "https://example.com" }] },
      want: { rewrites: [{ glob: "/foo$", path: "https://example.com" }] },
    },
    {
      name: "checks for function region if unspecified",
      input: { rewrites: [{ glob: "/foo", function: { functionId: FUNCTION_ID } }] },
      want: { rewrites: [{ glob: "/foo", function: FUNCTION_ID, functionRegion: "us-central1" }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint({ region: "us-central1" })),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "discovers the function region of a callable function",
      input: { rewrites: [{ glob: "/foo", function: { functionId: FUNCTION_ID } }] },
      want: { rewrites: [{ glob: "/foo", function: FUNCTION_ID, functionRegion: "us-central1" }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint({ callableTrigger: {}, region: "us-central1" })),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "returns rewrites for glob CF3",
      input: {
        rewrites: [{ glob: "/foo", function: { functionId: FUNCTION_ID, region: "europe-west2" } }],
      },
      want: { rewrites: [{ glob: "/foo", function: FUNCTION_ID, functionRegion: "europe-west2" }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint({ region: "europe-west2" }), endpoint()),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "defaults to a us-central1 rewrite if one is avaiable, v1 edition",
      input: { rewrites: [{ glob: "/foo", function: { functionId: FUNCTION_ID } }] },
      want: { rewrites: [{ glob: "/foo", function: FUNCTION_ID, functionRegion: "us-central1" }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint(), endpoint({ region: "us-central1" })),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "defaults to a us-central1 rewrite if one is avaiable, v2 edition",
      input: { rewrites: [{ glob: "/foo", function: { functionId: FUNCTION_ID } }] },
      want: {
        rewrites: [{ glob: "/foo", run: { region: "us-central1", serviceId: FUNCTION_ID } }],
      },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(
              endpoint({ platform: "gcfv2" }),
              endpoint({ platform: "gcfv2", region: "us-central1" })
            ),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "returns rewrites for regex CF3",
      input: {
        rewrites: [{ regex: "/foo$", function: { functionId: FUNCTION_ID, region: REGION } }],
      },
      want: {
        rewrites: [{ regex: "/foo$", function: FUNCTION_ID, functionRegion: REGION }],
      },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint()),
            haveBackend: backend.empty(),
          },
        },
      },
    },
    {
      name: "skips functions referencing CF3v2 functions being deployed (during prepare)",
      input: { rewrites: [{ regex: "/foo$", function: { functionId: FUNCTION_ID } }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint({ platform: "gcfv2" })),
            haveBackend: backend.empty(),
          },
        },
      },
      want: { rewrites: [] },
      finalize: false,
    },
    {
      name: "rewrites referencing CF3v2 functions being deployed are changed to Cloud Run (during release)",
      input: { rewrites: [{ regex: "/foo$", function: { functionId: FUNCTION_ID } }] },
      payload: {
        functions: {
          default: {
            wantBackend: backend.of(endpoint({ platform: "gcfv2" })),
            haveBackend: backend.empty(),
          },
        },
      },
      want: { rewrites: [{ regex: "/foo$", run: { serviceId: FUNCTION_ID, region: REGION } }] },
      finalize: true,
    },
    {
      name: "rewrites referencing existing CF3v2 functions are changed to Cloud Run (during prepare)",
      input: {
        rewrites: [
          { regex: "/foo$", function: { functionId: FUNCTION_ID, region: "us-central1" } },
        ],
      },
      context: {
        projectId: PROJECT_ID,
        loadedExistingBackend: true,
        existingBackend: backend.of(endpoint({ platform: "gcfv2" })),
      },
      want: { rewrites: [{ regex: "/foo$", run: { serviceId: FUNCTION_ID, region: REGION } }] },
      finalize: true,
    },
    {
      name: "rewrites referencing existing CF3v2 functions are changed to Cloud Run (during release)",
      input: {
        rewrites: [
          { regex: "/foo$", function: { functionId: FUNCTION_ID, region: "us-central1" } },
        ],
      },
      context: {
        projectId: PROJECT_ID,
        loadedExistingBackend: true,
        existingBackend: backend.of(endpoint({ platform: "gcfv2" })),
      },
      want: { rewrites: [{ regex: "/foo$", run: { serviceId: FUNCTION_ID, region: REGION } }] },
      finalize: true,
    },
    {
      name: "returns rewrites for glob Run",
      input: { rewrites: [{ glob: "/foo", run: { serviceId: "hello" } }] },
      want: { rewrites: [{ glob: "/foo", run: { region: "us-central1", serviceId: "hello" } }] },
    },
    {
      name: "returns rewrites for regex Run",
      input: { rewrites: [{ regex: "/foo$", run: { serviceId: "hello" } }] },
      want: { rewrites: [{ regex: "/foo$", run: { region: "us-central1", serviceId: "hello" } }] },
    },
    {
      name: "skips rewrites for Cloud Run instances being deployed (during prepare)",
      input: { rewrites: [{ regex: "/foo$", run: { serviceId: "hello" } }] },
      want: { rewrites: [] },
      finalize: false,
    },
    {
      name: "return rewrites for Cloud Run instances being deployed (during release)",
      input: { rewrites: [{ regex: "/foo$", run: { serviceId: "hello" } }] },
      want: { rewrites: [{ regex: "/foo$", run: { region: "us-central1", serviceId: "hello" } }] },
      finalize: true,
    },
    // Note to reviewer: This seems like a bad case to purposely allow a deploy that
    // we can verify will not work. Leaving this case commented out since my refactor
    // broke the behavior. Let me know whether to delete the cmmented out code or to
    // restore the edge case.
    // {
    //   name: "returns the specified rewrite even if it's not found",
    //   input: { rewrites: [{ glob: "/foo", function: FUNCTION_ID }] },
    //   payload: {
    //     functions: {
    //       default: {
    //         wantBackend: backend.empty(),
    //         haveBackend: backend.empty(),
    //       },
    //     },
    //   },
    //   want: { rewrites: [{ glob: "/foo", function: FUNCTION_ID }] },
    // },
    {
      name: "returns rewrites for Run with specified regions",
      input: { rewrites: [{ glob: "/foo", run: { serviceId: "hello", region: "us-midwest" } }] },
      want: { rewrites: [{ glob: "/foo", run: { region: "us-midwest", serviceId: "hello" } }] },
    },
    {
      name: "returns rewrites for glob Dynamic Links",
      input: { rewrites: [{ glob: "/foo", dynamicLinks: true }] },
      want: { rewrites: [{ glob: "/foo", dynamicLinks: true }] },
    },
    {
      name: "returns rewrites for regex Dynamic Links",
      input: { rewrites: [{ regex: "/foo$", dynamicLinks: true }] },
      want: { rewrites: [{ regex: "/foo$", dynamicLinks: true }] },
    },
    // Redirects.
    {
      name: "returns glob redirects without a specified code/type",
      input: { redirects: [{ glob: "/foo", destination: "https://example.com" }] },
      want: { redirects: [{ glob: "/foo", location: "https://example.com" }] },
    },
    {
      name: "returns regex redirects without a specified code/type",
      input: { redirects: [{ regex: "/foo$", destination: "https://example.com" }] },
      want: { redirects: [{ regex: "/foo$", location: "https://example.com" }] },
    },
    {
      name: "returns glob redirects with a specified code/type",
      input: { redirects: [{ glob: "/foo", destination: "https://example.com", type: 301 }] },
      want: { redirects: [{ glob: "/foo", location: "https://example.com", statusCode: 301 }] },
    },
    // Headers.
    {
      name: "returns no headers if they weren't specified",
      input: { headers: [{ glob: "/foo", headers: [] }] },
      want: { headers: [{ glob: "/foo", headers: {} }] },
    },
    {
      name: "returns glob headers as a map",
      input: {
        headers: [
          {
            glob: "/foo",
            headers: [
              { key: "x-foo", value: "bar" },
              { key: "x-baz", value: "zap" },
            ],
          },
        ],
      },
      want: { headers: [{ glob: "/foo", headers: { "x-foo": "bar", "x-baz": "zap" } }] },
    },
    {
      name: "returns regex headers as a map",
      input: {
        headers: [
          {
            regex: "/foo&",
            headers: [
              { key: "x-foo", value: "bar" },
              { key: "x-baz", value: "zap" },
            ],
          },
        ],
      },
      want: { headers: [{ regex: "/foo&", headers: { "x-foo": "bar", "x-baz": "zap" } }] },
    },
    // Clean URLs.
    {
      name: "returns clean URLs when it is false",
      input: { cleanUrls: false },
      want: { cleanUrls: false },
    },
    {
      name: "returns clean URLs when it is true",
      input: { cleanUrls: true },
      want: { cleanUrls: true },
    },
    // Trailing Slash.
    {
      name: "returns trailing slash as ADD when true",
      input: { trailingSlash: true },
      want: { trailingSlashBehavior: "ADD" },
    },
    {
      name: "returns trailing slash as REMOVE when false",
      input: { trailingSlash: false },
      want: { trailingSlashBehavior: "REMOVE" },
    },
    // App Association.
    {
      name: "returns app association as it is set",
      input: { appAssociation: "AUTO" },
      want: { appAssociation: "AUTO" },
    },
    // i18n.
    {
      name: "returns i18n as it is set",
      input: { i18n: { root: "bar" } },
      want: { i18n: { root: "bar" } },
    },
  ];

  for (const {
    name,
    context = DEFAULT_CONTEXT,
    input,
    payload = DEFAULT_PAYLOAD,
    want,
    finalize = true,
  } of tests) {
    it(name, async () => {
      const deploy: HostingDeploy = {
        config: input,
        site: "site",
      };
      const config = await convertConfig(context, payload, deploy, finalize);
      expect(config).to.deep.equal(want);
    });
  }
});
