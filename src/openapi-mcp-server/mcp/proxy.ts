import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  JSONRPCResponse,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIToMCPConverter } from "../openapi/parser";
import { HttpClient, HttpClientError } from "../client/http-client";
import { OpenAPIV3 } from "openapi-types";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject;
  put?: OpenAPIV3.OperationObject;
  post?: OpenAPIV3.OperationObject;
  delete?: OpenAPIV3.OperationObject;
  patch?: OpenAPIV3.OperationObject;
};

type NewToolDefinition = {
  methods: Array<{
    name: string;
    description: string;
    inputSchema: IJsonSchema & { type: "object" };
    returnSchema?: IJsonSchema;
  }>;
};

// import this class, extend and return server
export class MCPProxy {
  private server: Server;
  private httpClient: HttpClient;
  private tools: Record<string, NewToolDefinition>;
  private openApiLookup: Record<
    string,
    OpenAPIV3.OperationObject & { method: string; path: string }
  >;
  private openApiSpec: OpenAPIV3.Document; // NEW: Store spec for dynamic HttpClient creation
  private getSessionToken?: (sessionId: string) => string | undefined; // NEW: Token lookup function
  private transport?: Transport; // NEW: Store transport reference to access sessionId

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server(
      { name, version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.openApiSpec = openApiSpec; // NEW: Store the spec
    const baseUrl = openApiSpec.servers?.[0].url;
    if (!baseUrl) {
      throw new Error("No base URL found in OpenAPI spec");
    }
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: this.parseHeadersFromEnv(),
      },
      openApiSpec
    );

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec);
    const { tools, openApiLookup } = converter.convertToMCPTools();
    this.tools = tools;
    this.openApiLookup = openApiLookup;

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach((method) => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);
          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool["inputSchema"],
          });
        });
      });

      return { tools };
    });

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params;

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name);
      if (!operation) {
        throw new Error(`Method ${name} not found`);
      }

      try {
        // NEW: Get session ID from transport and look up custom Notion token
        // CRITICAL: Notion API requires Authorization header for ALL requests
        // If no custom token provided, fall back to default HttpClient (which uses NOTION_TOKEN from startup)
        // If default HttpClient also has no token, the Notion API call will fail with 401 Unauthorized
        const sessionId = this.getCurrentSessionId();
        const customNotionToken =
          sessionId && this.getSessionToken
            ? this.getSessionToken(sessionId)
            : undefined;

        // NEW: Create HttpClient with custom token if provided, otherwise use default
        const httpClient = customNotionToken
          ? this.createHttpClientWithToken(customNotionToken)
          : this.httpClient; // Uses NOTION_TOKEN from env var (if set at startup)

        // Execute the operation
        const response = await httpClient.executeOperation(operation, params);

        // Convert response to MCP format
        return {
          content: [
            {
              type: "text", // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(response.data), // TODO: pass through the http status code text?
            },
          ],
        };
      } catch (error) {
        console.error("Error in tool call", error);
        if (error instanceof HttpClientError) {
          console.error(
            "HttpClientError encountered, returning structured error",
            error
          );
          const data = error.data?.response?.data ?? error.data ?? {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "error", // TODO: get this from http status code?
                  ...(typeof data === "object" ? data : { data: data }),
                }),
              },
            ],
          };
        }
        throw error;
      }
    });
  }

  private findOperation(
    operationId: string
  ): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null;
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS;
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson);
        if (typeof headers !== "object" || headers === null) {
          console.warn(
            "OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:",
            typeof headers
          );
        } else if (Object.keys(headers).length > 0) {
          // Only use OPENAPI_MCP_HEADERS if it contains actual headers
          return headers;
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn(
          "Failed to parse OPENAPI_MCP_HEADERS environment variable:",
          error
        );
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN;
    if (notionToken) {
      return {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
      };
    }

    return {};
  }

  private getContentType(headers: Headers): "text" | "image" | "binary" {
    const contentType = headers.get("content-type");
    if (!contentType) return "binary";

    if (contentType.includes("text") || contentType.includes("json")) {
      return "text";
    } else if (contentType.includes("image")) {
      return "image";
    }
    return "binary";
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  /**
   * NEW: Set token lookup function for multi-tenant support
   * This function will be called with a session ID to retrieve the Notion token for that session
   *
   * @param lookup - Function that takes a session ID and returns the Notion token (or undefined)
   */
  setSessionTokenLookup(lookup: (sessionId: string) => string | undefined) {
    this.getSessionToken = lookup;
  }

  /**
   * NEW: Get current session ID from transport
   * The transport has a sessionId property that we can access
   *
   * @returns Session ID if available, undefined otherwise
   */
  private getCurrentSessionId(): string | undefined {
    // Access sessionId from transport if it's a StreamableHTTPServerTransport
    // TypeScript doesn't know about sessionId, so we use type assertion
    if (this.transport && "sessionId" in this.transport) {
      return (this.transport as any).sessionId as string | undefined;
    }
    return undefined;
  }

  /**
   * NEW: Create a new HttpClient instance with a custom Notion token.
   * This allows per-request token switching for multi-tenant support.
   *
   * @param token - Notion integration token (e.g., "ntn_xxx")
   * @returns New HttpClient instance configured with the token
   */
  private createHttpClientWithToken(token: string): HttpClient {
    // Validate token format
    if (!token || typeof token !== "string") {
      throw new Error("Invalid Notion token: token must be a non-empty string");
    }

    if (!token.startsWith("ntn_")) {
      console.warn(
        `Notion token does not start with 'ntn_': ${token.substring(0, 10)}...`
      );
    }

    const baseUrl = this.openApiSpec.servers?.[0].url;
    if (!baseUrl) {
      throw new Error("No base URL found in OpenAPI spec");
    }

    return new HttpClient(
      {
        baseUrl,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      },
      this.openApiSpec
    );
  }

  async connect(transport: Transport) {
    // NEW: Store transport reference to access sessionId later
    this.transport = transport;
    // The SDK will handle stdio communication
    await this.server.connect(transport);
  }

  getServer() {
    return this.server;
  }
}
