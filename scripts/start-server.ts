/**
 * Notion MCP Server Startup Script
 *
 * This script is the entry point for starting the Notion MCP (Model Context Protocol) server.
 * It supports two transport modes:
 * - STDIO: Standard input/output (for CLI/desktop apps like Claude Desktop)
 * - HTTP: Streamable HTTP transport (for backend/web applications)
 */

// Core Node.js modules for path resolution and file operations
import path from "node:path";
import { fileURLToPath } from "url";

// MCP SDK transports for different communication modes
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// Node.js crypto module for generating secure tokens and UUIDs
import { randomUUID, randomBytes } from "node:crypto";

// Express.js for HTTP server functionality (when using HTTP transport)
import express from "express";

// Local imports: Proxy initialization and custom logger
import { initProxy, ValidationError } from "../src/init-server";
import { logger } from "../src/utils/logger";

/**
 * Main server startup function
 *
 * This function orchestrates the entire server startup process:
 * 1. Resolves the path to the OpenAPI specification file
 * 2. Parses command-line arguments to determine transport mode and configuration
 * 3. Initializes the appropriate transport (STDIO or HTTP)
 * 4. Sets up authentication and routing (for HTTP transport)
 *
 * @param args - Command-line arguments array (defaults to process.argv)
 * @returns Promise resolving to the server instance or proxy server
 */
export async function startServer(args: string[] = process.argv) {
  // Resolve the absolute path to this script file
  // This is necessary because we're using ES modules (import.meta.url)
  const filename = fileURLToPath(import.meta.url);

  // Get the directory containing this script (scripts/)
  const directory = path.dirname(filename);

  // Resolve the path to the Notion OpenAPI specification JSON file
  // This file defines all available Notion API endpoints and their schemas
  const specPath = path.resolve(directory, "../scripts/notion-openapi.json");

  // Read BASE_URL from environment variable (optional override for Notion API base URL)
  // If not set, the default from the OpenAPI spec will be used (https://api.notion.com)
  const baseUrl = process.env.BASE_URL ?? undefined;

  /**
   * Parse command-line arguments manually
   *
   * This function extracts configuration from command-line arguments:
   * - --transport: Either "stdio" or "http" (defaults to "stdio")
   * - --port: Port number for HTTP server (defaults to 3000)
   * - --auth-token: Bearer token for HTTP authentication (optional)
   * - --help or -h: Display help message and exit
   *
   * We parse manually instead of using a library to keep dependencies minimal
   * and maintain compatibility with the MCP SDK's argument passing style.
   *
   * @returns Object containing parsed transport, port, and authToken
   */
  function parseArgs() {
    // Skip first two arguments: node executable path and script path
    // We only want the user-provided arguments
    const args = process.argv.slice(2);

    // Default values if no arguments provided
    let transport = "stdio"; // Default to STDIO for compatibility with desktop apps
    let port = 3000; // Default HTTP port
    let authToken: string | undefined; // No default token (will be auto-generated if needed)

    // Iterate through all arguments
    for (let i = 0; i < args.length; i++) {
      // Check for --transport argument
      // Format: --transport <type> where type is "stdio" or "http"
      if (args[i] === "--transport" && i + 1 < args.length) {
        transport = args[i + 1];
        i++; // Skip the next argument since we've consumed it
      }
      // Check for --port argument
      // Format: --port <number> where number is the port to listen on
      else if (args[i] === "--port" && i + 1 < args.length) {
        port = parseInt(args[i + 1], 10); // Parse as base-10 integer
        i++; // Skip the next argument since we've consumed it
      }
      // Check for --auth-token argument
      // Format: --auth-token <token> where token is the bearer token for HTTP auth
      else if (args[i] === "--auth-token" && i + 1 < args.length) {
        authToken = args[i + 1];
        i++; // Skip the next argument since we've consumed it
      }
      // Check for help flag
      // Display usage information and exit immediately
      else if (args[i] === "--help" || args[i] === "-h") {
        // Help message goes to console (not logger) since it's user-facing documentation
        // Users need to see this immediately, not in log files
        console.log(`
Usage: notion-mcp-server [options]

Options:
  --transport <type>     Transport type: 'stdio' or 'http' (default: stdio)
  --port <number>        Port for HTTP server when using Streamable HTTP transport (default: 3000)
  --auth-token <token>   Bearer token for HTTP transport authentication (optional)
  --help, -h             Show this help message

Environment Variables:
  NOTION_TOKEN           Notion integration token (recommended)
  OPENAPI_MCP_HEADERS    JSON string with Notion API headers (alternative)
  AUTH_TOKEN             Bearer token for HTTP transport authentication (alternative to --auth-token)
  DEBUG_MODE             Set to "true" to enable verbose debug logging (default: false)

Examples:
  notion-mcp-server                                    # Use stdio transport (default)
  notion-mcp-server --transport stdio                  # Use stdio transport explicitly
  notion-mcp-server --transport http                   # Use Streamable HTTP transport on port 3000
  notion-mcp-server --transport http --port 8080       # Use Streamable HTTP transport on port 8080
  notion-mcp-server --transport http --auth-token mytoken # Use Streamable HTTP transport with custom auth token
  AUTH_TOKEN=mytoken notion-mcp-server --transport http # Use Streamable HTTP transport with auth token from env var
  DEBUG_MODE=true notion-mcp-server --transport http   # Enable debug logging
`);
        // Exit immediately after showing help (exit code 0 = success)
        process.exit(0);
      }
      // Ignore unrecognized arguments silently
      // This allows Docker or other wrappers to pass additional arguments without breaking
      // For example, Docker might pass the container name as an argument
    }

    // Normalize transport to lowercase for case-insensitive comparison
    // Return parsed configuration object
    return { transport: transport.toLowerCase(), port, authToken };
  }

  // Parse command-line arguments to get configuration
  const options = parseArgs();
  const transport = options.transport;

  // ============================================================================
  // STDIO TRANSPORT MODE
  // ============================================================================
  // This mode is used by desktop applications like Claude Desktop, Cursor, etc.
  // The server communicates via standard input/output streams (stdin/stdout).
  // No HTTP endpoints are exposed - all communication happens through pipes.
  if (transport === "stdio") {
    // Initialize the MCP proxy with the Notion OpenAPI specification
    // The proxy acts as a bridge between MCP protocol and Notion API
    const proxy = await initProxy(specPath, baseUrl);

    // Connect the proxy to STDIO transport
    // This sets up the server to read from stdin and write to stdout
    await proxy.connect(new StdioServerTransport());

    // Return the underlying server instance for compatibility
    return proxy.getServer();
  }
  // ============================================================================
  // HTTP TRANSPORT MODE
  // ============================================================================
  // This mode is used by backend services and web applications.
  // The server exposes HTTP endpoints (/mcp and /health) for remote access.
  // Requires authentication via bearer token for security.
  else if (transport === "http") {
    // ============================================================================
    // HTTP SERVER SETUP
    // ============================================================================

    // Create Express.js application instance
    // Express handles HTTP request routing and middleware
    const app = express();

    // Enable JSON body parsing middleware
    // This allows the server to automatically parse JSON request bodies
    // Required for MCP protocol messages which are sent as JSON
    app.use(express.json());

    // ============================================================================
    // AUTHENTICATION TOKEN GENERATION
    // ============================================================================
    // The server needs a bearer token to secure HTTP endpoints.
    // Priority order (highest to lowest):
    // 1. Command-line argument (--auth-token)
    // 2. Environment variable (AUTH_TOKEN)
    // 3. Auto-generated secure random token (fallback)
    const authToken =
      options.authToken ||
      process.env.AUTH_TOKEN ||
      randomBytes(32).toString("hex"); // Generate 32 bytes (256 bits) of random data, convert to hex string

    // If no token was provided, the server auto-generated one
    // We need to inform the user so they can configure their client
    if (!options.authToken && !process.env.AUTH_TOKEN) {
      // Log to file for later reference
      logger.info("Generated new auth token", { component: "auth" });

      // Also log to console for immediate visibility
      // This is critical - users need to see the token to configure their backend
      console.log(`Generated auth token: ${authToken}`);
      console.log(
        `Use this token in the Authorization header: Bearer ${authToken}`
      );
    } else {
      // Token was provided via CLI or env var - log debug info (only if DEBUG_MODE enabled)
      logger.debug("Using provided auth token", {
        component: "auth",
        tokenProvided: true,
      });
    }

    // ============================================================================
    // AUTHENTICATION MIDDLEWARE
    // ============================================================================
    // This middleware validates bearer token authentication for all protected routes.
    // It checks for "Authorization: Bearer <token>" header and compares against the server's token.
    //
    // Security: This prevents unauthorized access to the MCP endpoints.
    // Only clients with the correct bearer token can make MCP requests.
    const authenticateToken = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): void => {
      // Extract the Authorization header from the request
      // Format should be: "Bearer <token>"
      const authHeader = req.headers["authorization"];

      // Split the header to extract just the token part
      // "Bearer TOKEN" -> ["Bearer", "TOKEN"] -> "TOKEN"
      // If no header or invalid format, token will be undefined
      const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

      // Case 1: No token provided in the request
      if (!token) {
        // Log the authentication failure for security monitoring
        logger.warning("Authentication failed: Missing bearer token", {
          component: "auth",
          ip: req.ip, // Log client IP for security tracking
          path: req.path, // Log which endpoint was accessed
        });

        // Return 401 Unauthorized with JSON-RPC error format
        // This maintains consistency with MCP protocol error responses
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001, // Custom error code for missing auth token
            message: "Unauthorized: Missing bearer token",
          },
          id: null, // No request ID since this is a middleware-level error
        });
        return; // Stop request processing
      }

      // Case 2: Token provided but doesn't match server's token
      if (token !== authToken) {
        // Log the authentication failure
        logger.warning("Authentication failed: Invalid bearer token", {
          component: "auth",
          ip: req.ip,
          path: req.path,
        });

        // Return 403 Forbidden with JSON-RPC error format
        res.status(403).json({
          jsonrpc: "2.0",
          error: {
            code: -32002, // Custom error code for invalid auth token
            message: "Forbidden: Invalid bearer token",
          },
          id: null,
        });
        return; // Stop request processing
      }

      // Case 3: Authentication successful
      // Log success (only if DEBUG_MODE enabled to avoid log spam)
      logger.debug("Authentication successful", {
        component: "auth",
        ip: req.ip,
        path: req.path,
      });

      // Call next() to continue to the next middleware/route handler
      next();
    };

    // ============================================================================
    // HEALTH CHECK ENDPOINT
    // ============================================================================
    // This endpoint allows monitoring tools and scripts to verify server is running.
    // No authentication required - this is a public endpoint for health checks.
    // The restart-server.sh script uses this to verify the server started successfully.
    app.get("/health", (req, res) => {
      // Log health check requests (only if DEBUG_MODE enabled)
      logger.debug("Health check requested", {
        component: "health",
        ip: req.ip,
      });

      // Return server status information
      res.status(200).json({
        status: "healthy", // Server is operational
        timestamp: new Date().toISOString(), // Current server time (ISO 8601 format)
        transport: "http", // Transport mode being used
        port: options.port, // Port the server is listening on
      });
    });

    // ============================================================================
    // APPLY AUTHENTICATION TO MCP ENDPOINTS
    // ============================================================================
    // All routes under /mcp require bearer token authentication.
    // This middleware runs before any /mcp route handlers.
    // If authentication fails, the request is rejected before reaching the handler.
    app.use("/mcp", authenticateToken);

    // ============================================================================
    // SESSION MANAGEMENT
    // ============================================================================
    // The MCP protocol supports multiple concurrent sessions.
    // Each session has its own transport instance, identified by a session ID.
    // This map stores active transports so we can route requests to the correct session.
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
      {};

    // ============================================================================
    // POST /mcp - CLIENT-TO-SERVER COMMUNICATION
    // ============================================================================
    // This endpoint handles MCP protocol requests from clients (backend services).
    // Clients send JSON-RPC messages here to invoke tools, query resources, etc.
    //
    // Request flow:
    // 1. Client sends POST with MCP request in body
    // 2. Server checks for existing session or creates new one
    // 3. Server routes request to appropriate transport/session
    // 4. Transport processes the MCP request and returns response
    app.post("/mcp", async (req, res) => {
      try {
        // Extract session ID from request headers
        // The MCP protocol uses "mcp-session-id" header to identify sessions
        // If this is a new session, the header won't be present
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        // Case 1: Existing session - reuse the transport
        // If a session ID is provided and we have a transport for it, reuse it
        // This allows multiple requests within the same session
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        }
        // Case 2: New session initialization
        // If no session ID is provided AND the request is an "initialize" request,
        // we need to create a new session and transport
        else if (!sessionId && isInitializeRequest(req.body)) {
          // Create a new Streamable HTTP transport instance
          // This transport handles the MCP protocol communication over HTTP
          transport = new StreamableHTTPServerTransport({
            // Generate a unique UUID for this session
            // This ID will be used to identify all subsequent requests in this session
            sessionIdGenerator: () => randomUUID(),

            // Callback when session is initialized
            // This gives us the session ID so we can store the transport for later use
            onsessioninitialized: (sessionId) => {
              // Store the transport in our map so we can retrieve it later
              transports[sessionId] = transport;
            },
          });

          // Clean up transport when session is closed
          // This prevents memory leaks by removing closed sessions from the map
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
            }
          };

          // Initialize the MCP proxy for this transport
          // The proxy connects the transport to the Notion API
          const proxy = await initProxy(specPath, baseUrl);

          // Connect the proxy to the transport
          // This establishes the MCP protocol connection
          await proxy.connect(transport);
        }
        // Case 3: Invalid request
        // Request has session ID but no matching transport, OR
        // Request is not an initialize request but has no session ID
        else {
          // Return 400 Bad Request with JSON-RPC error format
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000, // Custom error code for invalid request
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return; // Stop processing
        }

        // Handle the MCP request
        // Log the request (only if DEBUG_MODE enabled)
        logger.debug("Processing MCP request", {
          component: "mcp",
          sessionId,
          method: req.method,
          path: req.path,
        });

        // Delegate request handling to the transport
        // The transport processes the MCP protocol message and sends the response
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        // Error handling: Log the error and return appropriate response
        logger.error(
          "Error handling MCP request",
          {
            component: "mcp",
            sessionId: req.headers["mcp-session-id"] as string | undefined,
            method: req.method,
            path: req.path,
          },
          error as Error
        );

        // Only send error response if headers haven't been sent yet
        // This prevents "Cannot set headers after they are sent" errors
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603, // JSON-RPC internal error code
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    // ============================================================================
    // GET /mcp - SERVER-TO-CLIENT NOTIFICATIONS
    // ============================================================================
    // The MCP protocol supports server-to-client notifications (e.g., progress updates).
    // Clients poll this endpoint to receive notifications from the server.
    // This uses long-polling or streaming HTTP to deliver notifications.
    app.get("/mcp", async (req, res) => {
      // Extract session ID from headers
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Validate that we have a valid session
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      // Get the transport for this session
      const transport = transports[sessionId];

      // Handle the notification request
      // The transport will handle the streaming/long-polling logic
      await transport.handleRequest(req, res);
    });

    // ============================================================================
    // DELETE /mcp - SESSION TERMINATION
    // ============================================================================
    // Clients can explicitly terminate a session by sending a DELETE request.
    // This cleans up the session and releases resources.
    // The transport's onclose callback will be triggered to remove it from the map.
    app.delete("/mcp", async (req, res) => {
      // Extract session ID from headers
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Validate that we have a valid session
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      // Get the transport for this session
      const transport = transports[sessionId];

      // Handle the termination request
      // The transport will close the session and trigger cleanup
      await transport.handleRequest(req, res);
    });

    // ============================================================================
    // START HTTP SERVER
    // ============================================================================
    // Bind the Express app to the specified port and start listening for requests.
    // We listen on "0.0.0.0" (all network interfaces) to allow external connections.
    // This is necessary for Docker containers and remote access.
    const port = options.port;

    // Start the HTTP server
    app.listen(port, "0.0.0.0", () => {
      // Log server startup to file (structured logging)
      logger.info("MCP Server started", {
        component: "server",
        transport: "http",
        port,
        endpoint: `http://0.0.0.0:${port}/mcp`,
        healthCheck: `http://0.0.0.0:${port}/health`,
        authTokenProvided: !!options.authToken, // Whether token was provided (not auto-generated)
      });

      // Also log to console for immediate user visibility
      // Users need to see this information right away
      console.log(`MCP Server listening on port ${port}`);
      console.log(`Endpoint: http://0.0.0.0:${port}/mcp`);
      console.log(`Health check: http://0.0.0.0:${port}/health`);
      console.log(`Authentication: Bearer token required`);

      // Indicate if token was provided (helpful for debugging)
      if (options.authToken) {
        console.log(`Using provided auth token`);
      }
    });

    // Return a dummy server object for compatibility
    // Some code may expect a server object with a close() method
    // The actual Express server is managed internally
    return { close: () => {} };
  }
  // ============================================================================
  // UNSUPPORTED TRANSPORT MODE
  // ============================================================================
  // If transport is neither "stdio" nor "http", throw an error.
  // This prevents silent failures and clearly indicates configuration issues.
  else {
    throw new Error(
      `Unsupported transport: ${transport}. Use 'stdio' or 'http'.`
    );
  }
}

// ============================================================================
// SCRIPT ENTRY POINT
// ============================================================================
// This is the entry point when the script is executed directly.
// It calls startServer() with process.argv (command-line arguments) and handles errors.

startServer(process.argv).catch((error) => {
  // Handle different types of errors appropriately

  // Case 1: OpenAPI specification validation error
  // This happens if the notion-openapi.json file is invalid or malformed
  if (error instanceof ValidationError) {
    // Log to file with structured format
    logger.error("Invalid OpenAPI 3.1 specification", {
      component: "validation",
      errors: error.errors, // Include validation error details
    });

    // Also log to console for immediate visibility
    // Users need to see this immediately to fix the issue
    console.error("Invalid OpenAPI 3.1 specification:");
    error.errors.forEach((err) => console.error(err));
  }
  // Case 2: Any other error (network, file system, etc.)
  else {
    // Log as critical since server failed to start
    logger.critical(
      "Failed to start server",
      {
        component: "server",
      },
      error as Error
    );

    // Also log to console for immediate visibility
    console.error("Error:", error);
  }

  // Exit with error code 1 to indicate failure
  // This allows shell scripts and process managers to detect the failure
  process.exit(1);
});
