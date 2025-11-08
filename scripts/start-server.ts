/**
 * Notion MCP Server Startup Script
 *
 * This script is the entry point for starting the Notion MCP (Model Context Protocol) server.
 * It supports two transport modes:
 * - STDIO: Standard input/output (for CLI/desktop apps like Claude Desktop)
 * - HTTP: Streamable HTTP transport (for backend/web applications)
 *
 * The script orchestrates:
 * 1. Path resolution (finding OpenAPI spec file)
 * 2. Command-line argument parsing
 * 3. Transport mode selection (STDIO vs HTTP)
 * 4. Server initialization (proxy, transport, routes)
 * 5. Error handling and logging
 */

/**
 * Core Node.js modules for path resolution and file operations
 *
 * - path: For resolving file paths (works with ES modules)
 * - fileURLToPath: Converts ES module URLs to file system paths
 */
import path from "node:path";
import { fileURLToPath } from "url";

/**
 * MCP SDK transports for different communication modes
 *
 * - StdioServerTransport: Handles MCP protocol over standard input/output
 *   Used by desktop applications that communicate via stdin/stdout pipes
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Node.js crypto module for generating secure tokens
 *
 * - randomBytes: Generates cryptographically secure random data
 *   Used to auto-generate authentication tokens when none are provided
 */
import { randomBytes } from "node:crypto";

/**
 * Express.js for HTTP server functionality
 *
 * Express is used when running in HTTP transport mode to:
 * - Handle HTTP requests
 * - Route requests to appropriate handlers
 * - Apply middleware (authentication, JSON parsing, etc.)
 */
import express from "express";

/**
 * Local imports: Core server components
 *
 * - initProxy: Initializes the MCP proxy (bridges MCP protocol to Notion API)
 * - ValidationError: Error type for OpenAPI specification validation failures
 * - logger: Structured logging utility
 * - parseArgs: Command-line argument parser
 * - createAuthMiddleware: Factory for authentication middleware
 * - SessionManager: Manages MCP sessions and Notion tokens
 * - MCP handlers: Route handlers for POST, GET, DELETE /mcp endpoints
 */
import { initProxy, ValidationError } from "../src/init-server";
import { logger } from "../src/utils/logger";
import { parseArgs, type ServerOptions } from "../src/utils/args-parser";
import { createAuthMiddleware } from "../src/middleware/auth";
import { SessionManager } from "../src/server/session-manager";
import {
  createMCPPostHandler,
  createMCPGetHandler,
  createMCPDeleteHandler,
} from "../src/server/mcp-handlers";

/**
 * Main server startup function
 *
 * This function orchestrates the entire server startup process:
 * 1. Resolves the path to the OpenAPI specification file
 * 2. Parses command-line arguments to determine transport mode and configuration
 * 3. Initializes the appropriate transport (STDIO or HTTP)
 * 4. Sets up authentication and routing (for HTTP transport)
 *
 * The function is async because proxy initialization and server startup are
 * asynchronous operations (reading files, setting up network listeners, etc.).
 *
 * @param args - Command-line arguments array (defaults to process.argv)
 *               Format: [node_executable, script_path, ...user_args]
 * @returns Promise resolving to the server instance or proxy server
 *          - For STDIO: Returns the underlying MCP server instance
 *          - For HTTP: Returns a dummy object with close() method for compatibility
 */
export async function startServer(args: string[] = process.argv) {
  /**
   * Resolve the absolute path to this script file
   *
   * In ES modules, we can't use __dirname (that's a CommonJS feature).
   * Instead, we use import.meta.url which gives us the URL of the current module.
   * fileURLToPath() converts the URL to a file system path.
   *
   * Example: import.meta.url might be "file:///path/to/scripts/start-server.ts"
   *          fileURLToPath() converts it to "/path/to/scripts/start-server.ts"
   */
  const filename = fileURLToPath(import.meta.url);

  /**
   * Get the directory containing this script (scripts/)
   *
   * We need this to resolve relative paths to other files (like the OpenAPI spec).
   * path.dirname() removes the filename and returns just the directory path.
   */
  const directory = path.dirname(filename);

  /**
   * Resolve the path to the Notion OpenAPI specification JSON file
   *
   * The OpenAPI specification file defines:
   * - All available Notion API endpoints
   * - Request/response schemas
   * - Authentication requirements
   * - Parameter definitions
   *
   * The MCP proxy uses this file to understand how to make Notion API calls.
   * We resolve it relative to the scripts directory to ensure we find it regardless
   * of where the process is executed from.
   *
   * Path: scripts/../scripts/notion-openapi.json (resolves to scripts/notion-openapi.json)
   */
  const specPath = path.resolve(directory, "../scripts/notion-openapi.json");

  /**
   * Read BASE_URL from environment variable (optional override for Notion API base URL)
   *
   * This allows overriding the Notion API base URL for:
   * - Testing (point to mock server)
   * - Custom deployments (self-hosted Notion API)
   * - Development (local Notion API instance)
   *
   * If not set, the default from the OpenAPI spec will be used (https://api.notion.com).
   * We use nullish coalescing (??) to convert empty strings to undefined.
   */
  const baseUrl = process.env.BASE_URL ?? undefined;

  /**
   * Parse command-line arguments to get configuration
   *
   * This extracts:
   * - transport: "stdio" or "http" (determines communication mode)
   * - port: Port number for HTTP server (only used in HTTP mode)
   * - authToken: Bearer token for HTTP authentication (optional)
   *
   * The parseArgs function handles defaults, validation, and help text.
   */
  const options = parseArgs(args);
  /**
   * Extract transport mode
   *
   * This determines which code path we take:
   * - "stdio": Desktop app mode (stdin/stdout communication)
   * - "http": Backend/web mode (HTTP endpoints)
   */
  const transport = options.transport;

  /**
   * ============================================================================
   * STDIO TRANSPORT MODE
   * ============================================================================
   *
   * This mode is used by desktop applications like Claude Desktop, Cursor, etc.
   * The server communicates via standard input/output streams (stdin/stdout).
   * No HTTP endpoints are exposed - all communication happens through pipes.
   *
   * How it works:
   * - Desktop app launches this script as a subprocess
   * - Desktop app writes MCP messages to stdin
   * - Server reads from stdin, processes, writes responses to stdout
   * - Desktop app reads from stdout to get responses
   *
   * This is simpler than HTTP mode because:
   * - No authentication needed (process isolation provides security)
   * - No session management (one process = one session)
   * - No network concerns (local communication only)
   */
  if (transport === "stdio") {
    /**
     * Initialize the MCP proxy with the Notion OpenAPI specification
     *
     * The proxy acts as a bridge between:
     * - MCP protocol (what desktop apps understand)
     * - Notion API (what we actually call)
     *
     * The proxy:
     * - Parses the OpenAPI spec to understand Notion API endpoints
     * - Converts MCP tool calls to Notion API requests
     * - Converts Notion API responses to MCP protocol messages
     *
     * We await this because initProxy is async (reads the OpenAPI spec file).
     */
    const proxy = await initProxy(specPath, baseUrl);

    /**
     * Connect the proxy to STDIO transport
     *
     * This sets up the server to:
     * - Read MCP messages from stdin (from desktop app)
     * - Process them through the proxy
     * - Write MCP responses to stdout (back to desktop app)
     *
     * After this call, the server is ready to handle MCP requests from stdin.
     * The server will run until the desktop app closes the process.
     */
    await proxy.connect(new StdioServerTransport());

    /**
     * Return the underlying server instance for compatibility
     *
     * Some code may expect a server object with methods like close().
     * We return the underlying MCP server instance from the proxy.
     * This allows callers to interact with the server if needed.
     */
    return proxy.getServer();
  } else if (transport === "http") {
  /**
   * ============================================================================
   * HTTP TRANSPORT MODE
   * ============================================================================
   *
   * This mode is used by backend services and web applications.
   * The server exposes HTTP endpoints (/mcp and /health) for remote access.
   * Requires authentication via bearer token for security.
   *
   * How it works:
   * - Clients make HTTP requests to /mcp endpoint
   * - Server validates authentication (bearer token)
   * - Server routes requests to appropriate MCP handler
   * - Handler processes MCP protocol messages
   * - Server sends HTTP responses back to clients
   *
   * This mode supports:
   * - Multiple concurrent sessions (multi-tenant)
   * - Remote access (not just local)
   * - Integration with backend services
   */
    /**
     * ============================================================================
     * HTTP SERVER SETUP
     * ============================================================================
     */

    /**
     * Create Express.js application instance
     *
     * Express is a web framework for Node.js that provides:
     * - HTTP request routing
     * - Middleware support (authentication, parsing, etc.)
     * - Response handling
     *
     * We create a new Express app instance to handle all HTTP requests.
     */
    const app = express();

    /**
     * Enable JSON body parsing middleware
     *
     * This middleware automatically parses JSON request bodies and makes them
     * available as req.body. This is required because:
     * - MCP protocol messages are sent as JSON
     * - We need to parse the JSON to extract the MCP method and parameters
     * - Without this, req.body would be undefined
     *
     * The middleware runs for all routes, so all requests can have JSON bodies.
     */
    app.use(express.json());

    /**
     * ============================================================================
     * AUTHENTICATION TOKEN GENERATION
     * ============================================================================
     *
     * The server needs a bearer token to secure HTTP endpoints.
     * This prevents unauthorized access to the MCP server.
     *
     * Priority order (highest to lowest):
     * 1. Command-line argument (--auth-token) - Most explicit, highest priority
     * 2. Environment variable (AUTH_TOKEN) - Good for deployment/config files
     * 3. Auto-generated secure random token (fallback) - Convenient for development
     *
     * We use the first available token in this order. If none are provided,
     * we generate a secure random token and display it to the user.
     */
    const authToken =
      options.authToken || // Check CLI argument first
      process.env.AUTH_TOKEN || // Then check environment variable
      randomBytes(32).toString("hex"); // Finally, generate a secure random token
    /**
     * randomBytes(32) generates 32 bytes (256 bits) of cryptographically secure
     * random data. We convert it to a hex string (64 characters) for use as
     * an authentication token. This provides 256 bits of entropy, making it
     * extremely difficult to guess or brute force.
     */

    /**
     * If no token was provided, the server auto-generated one
     *
     * When the server auto-generates a token, we need to inform the user so they
     * can configure their client to use it. This is critical - without the token,
     * clients won't be able to authenticate.
     */
    if (!options.authToken && !process.env.AUTH_TOKEN) {
      /**
       * Log to file for later reference
       *
       * We log that a token was generated so it's recorded in the log file.
       * This helps with debugging and auditing.
       */
      logger.info("Generated new auth token", { component: "auth" });

      /**
       * Also log to console for immediate visibility
       *
       * This is critical - users need to see the token immediately to configure
       * their backend. We output it to console so it's visible in the terminal
       * where the server was started.
       *
       * We show:
       * - The generated token (so users can copy it)
       * - How to use it (Authorization header format)
       */
      console.log(`Generated auth token: ${authToken}`);
      console.log(
        `Use this token in the Authorization header: Bearer ${authToken}`
      );
    } else {
      /**
       * Token was provided via CLI or env var
       *
       * If a token was explicitly provided, we don't need to display it
       * (security best practice - don't echo tokens). We just log debug info
       * to confirm we're using the provided token (only if DEBUG_MODE enabled).
       */
      logger.debug("Using provided auth token", {
        component: "auth",
        tokenProvided: true, // Indicates token was provided, not auto-generated
      });
    }

    /**
     * ============================================================================
     * AUTHENTICATION MIDDLEWARE
     * ============================================================================
     *
     * This middleware validates bearer token authentication for all protected routes.
     * It checks for "Authorization: Bearer <token>" header and compares against
     * the server's token.
     *
     * Security: This prevents unauthorized access to the MCP endpoints.
     * Only clients with the correct bearer token can make MCP requests.
     *
     * The middleware:
     * - Extracts the bearer token from the Authorization header
     * - Compares it against the server's configured token
     * - Returns 401/403 if invalid, allows request to proceed if valid
     */
    const authenticateToken = createAuthMiddleware(authToken);

    /**
     * ============================================================================
     * HEALTH CHECK ENDPOINT
     * ============================================================================
     *
     * This endpoint allows monitoring tools and scripts to verify the server is running.
     * No authentication required - this is a public endpoint for health checks.
     *
     * Use cases:
     * - The restart-server.sh script uses this to verify the server started successfully
     * - Monitoring tools can poll this endpoint to check server health
     * - Load balancers can use this for health checks
     * - Docker/Kubernetes can use this for liveness/readiness probes
     */
    app.get("/health", (req, res) => {
      /**
       * Log health check requests (only if DEBUG_MODE enabled)
       *
       * We log health checks at DEBUG level because:
       * - They happen frequently (would spam logs at INFO level)
       * - They're not critical for normal operation
       * - But they're useful for debugging connection issues
       */
      logger.debug("Health check requested", {
        component: "health", // Identifies this as health check logging
        ip: req.ip, // Log client IP (useful for debugging)
      });

      /**
       * Return server status information
       *
       * The health check response includes:
       * - status: "healthy" (indicates server is operational)
       * - timestamp: Current server time (ISO 8601 format, useful for clock sync checks)
       * - transport: "http" (confirms transport mode)
       * - port: Port the server is listening on (confirms correct port)
       *
       * This information helps verify the server is running correctly and
       * provides useful debugging information.
       */
      res.status(200).json({
        status: "healthy", // Server is operational
        timestamp: new Date().toISOString(), // Current server time (ISO 8601 format)
        transport: "http", // Transport mode being used
        port: options.port, // Port the server is listening on
      });
    });

    /**
     * ============================================================================
     * APPLY AUTHENTICATION TO MCP ENDPOINTS
     * ============================================================================
     *
     * All routes under /mcp require bearer token authentication.
     * This middleware runs before any /mcp route handlers.
     *
     * How it works:
     * - Express applies this middleware to all routes starting with "/mcp"
     * - The middleware checks the Authorization header before the request reaches handlers
     * - If authentication fails, the request is rejected with 401/403 before reaching handlers
     * - If authentication succeeds, the request proceeds to the route handler
     *
     * This ensures all MCP endpoints are protected, even if we add new routes later.
     */
    app.use("/mcp", authenticateToken);

    /**
     * ============================================================================
     * SESSION MANAGEMENT
     * ============================================================================
     *
     * The MCP protocol supports multiple concurrent sessions.
     * Each session has its own transport instance, identified by a session ID.
     *
     * The SessionManager handles:
     * - Transport storage (maps session IDs to transport instances)
     * - Token association (maps session IDs to Notion tokens for multi-tenant support)
     * - Session cleanup (removes sessions when they're closed)
     *
     * This enables:
     * - Multiple clients to connect simultaneously
     * - Each client to use a different Notion workspace (multi-tenant)
     * - Proper resource cleanup when sessions end
     */
    const sessionManager = new SessionManager();

    /**
     * ============================================================================
     * MCP ROUTE HANDLERS
     * ============================================================================
     *
     * These handlers process MCP protocol requests from clients.
     * They use the SessionManager to track sessions and route requests correctly.
     *
     * The handlers support:
     * - Session initialization (POST /mcp with initialize request)
     * - Request routing (POST /mcp with session ID)
     * - Server-to-client notifications (GET /mcp with session ID)
     * - Session termination (DELETE /mcp with session ID)
     */

    /**
     * POST /mcp - Client-to-server communication
     *
     * This is the main endpoint for MCP protocol communication.
     * It handles:
     * - Session initialization (new sessions)
     * - Tool calls (tools/call)
     * - Resource queries (resources/*)
     * - List operations (tools/list, resources/list)
     *
     * The handler uses the SessionManager to:
     * - Route requests to the correct session's transport
     * - Extract and store Notion tokens for multi-tenant support
     * - Create new sessions when needed
     */
    app.post(
      "/mcp",
      createMCPPostHandler({
        specPath, // Path to OpenAPI spec (for proxy initialization)
        baseUrl, // Optional Notion API base URL override
        sessionManager, // Session manager instance
        initProxy, // Function to initialize MCP proxy
      })
    );

    /**
     * GET /mcp - Server-to-client notifications
     *
     * The MCP protocol supports server-to-client notifications (e.g., progress updates,
     * resource changes, tool execution status). Clients poll this endpoint to receive
     * notifications from the server.
     *
     * This endpoint uses:
     * - Server-sent events (SSE) for streaming notifications
     * - Long-polling for efficient notification delivery
     *
     * The handler validates the session ID and routes to the correct transport.
     */
    app.get("/mcp", createMCPGetHandler(sessionManager));

    /**
     * DELETE /mcp - Session termination
     *
     * Clients can explicitly terminate a session by sending a DELETE request.
     * This is useful for:
     * - Graceful shutdown (client wants to close connection cleanly)
     * - Resource cleanup (free up server resources)
     * - Session management (client switching sessions)
     *
     * When a session is terminated:
     * - The transport's onclose callback is fired
     * - The session is removed from the SessionManager
     * - Resources (transport, token) are cleaned up
     */
    app.delete("/mcp", createMCPDeleteHandler(sessionManager));

    /**
     * ============================================================================
     * START HTTP SERVER
     * ============================================================================
     *
     * Bind the Express app to the specified port and start listening for requests.
     * We listen on "0.0.0.0" (all network interfaces) to allow external connections.
     *
     * Why "0.0.0.0" instead of "localhost" or "127.0.0.1"?
     * - "0.0.0.0" binds to all network interfaces (allows external connections)
     * - "localhost" or "127.0.0.1" only allows local connections
     * - This is necessary for Docker containers and remote access
     * - Clients can connect from other machines/containers
     */
    const port = options.port;

    /**
     * Start the HTTP server
     *
     * app.listen() binds the Express app to the specified port and starts
     * listening for incoming HTTP requests. The callback is fired once the
     * server is ready to accept connections.
     *
     * Parameters:
     * - port: The port number to listen on (from command-line args or default)
     * - "0.0.0.0": Bind to all network interfaces (allows external connections)
     * - callback: Function called when server is ready
     */
    app.listen(port, "0.0.0.0", () => {
      /**
       * Log server startup to file (structured logging)
       *
       * We log structured information about the server startup to the log file.
       * This includes:
       * - component: "server" (identifies this as server startup logging)
       * - transport: "http" (confirms transport mode)
       * - port: Port number (for debugging connection issues)
       * - endpoint: Full URL to MCP endpoint (for client configuration)
       * - healthCheck: Full URL to health check endpoint (for monitoring)
       * - authTokenProvided: Whether token was explicitly provided (not auto-generated)
       *
       * This structured logging makes it easy to search and analyze server startup events.
       */
      logger.info("MCP Server started", {
        component: "server", // Identifies this as server startup logging
        transport: "http", // Transport mode
        port, // Port number
        endpoint: `http://0.0.0.0:${port}/mcp`, // Full URL to MCP endpoint
        healthCheck: `http://0.0.0.0:${port}/health`, // Full URL to health check
        authTokenProvided: !!options.authToken, // Whether token was provided (not auto-generated)
      });

      /**
       * Also log to console for immediate user visibility
       *
       * Users need to see this information immediately in the terminal where
       * the server was started. This includes:
       * - Port number (so users know where to connect)
       * - Endpoint URL (so users can configure clients)
       * - Health check URL (so users can verify server is running)
       * - Authentication requirement (so users know they need a token)
       *
       * This console output is separate from file logging because:
       * - Console output is immediate and visible
       * - File logging is for later analysis
       * - Users need different information than what's in logs
       */
      console.log(`MCP Server listening on port ${port}`);
      console.log(`Endpoint: http://0.0.0.0:${port}/mcp`);
      console.log(`Health check: http://0.0.0.0:${port}/health`);
      console.log(`Authentication: Bearer token required`);

      /**
       * Indicate if token was provided (helpful for debugging)
       *
       * If a token was explicitly provided (via CLI or env var), we log that
       * to help users understand the authentication configuration. This is
       * useful for debugging authentication issues.
       */
      if (options.authToken) {
        console.log(`Using provided auth token`);
      }
    });

    /**
     * Return a dummy server object for compatibility
     *
     * Some code may expect a server object with a close() method (e.g., for
     * graceful shutdown). We return a dummy object with an empty close()
     * method to satisfy this expectation.
     *
     * The actual Express server is managed internally by Express and doesn't
     * need to be returned. If we need to close the server, we would need to
     * store a reference to the server returned by app.listen().
     */
    return { close: () => {} };
  } else {
  /**
   * ============================================================================
   * UNSUPPORTED TRANSPORT MODE
   * ============================================================================
   *
   * If transport is neither "stdio" nor "http", throw an error.
   * This prevents silent failures and clearly indicates configuration issues.
   *
   * This should never happen in normal usage because parseArgs() normalizes
   * transport values to lowercase and defaults to "stdio". However, if someone
   * manually sets an invalid transport value, we catch it here.
   */
    throw new Error(
      `Unsupported transport: ${transport}. Use 'stdio' or 'http'.`
    );
  }
}

/**
 * ============================================================================
 * SCRIPT ENTRY POINT
 * ============================================================================
 *
 * This is the entry point when the script is executed directly (not imported).
 * It calls startServer() with process.argv (command-line arguments) and handles errors.
 *
 * How it works:
 * 1. Call startServer() with process.argv (command-line arguments)
 * 2. If successful, server starts and runs indefinitely
 * 3. If error occurs, catch it, log it, and exit with error code
 *
 * Error handling:
 * - Different error types are handled differently (ValidationError vs others)
 * - Errors are logged to both file (structured) and console (immediate visibility)
 * - Process exits with code 1 to indicate failure (allows scripts to detect failure)
 */

/**
 * Start the server and handle any errors
 *
 * We use .catch() to handle any errors that occur during server startup.
 * This ensures errors are properly logged and the process exits with an
 * appropriate error code.
 */
startServer(process.argv).catch((error) => {
  /**
   * Handle different types of errors appropriately
   *
   * We distinguish between different error types to provide appropriate
   * error messages and logging. This helps users understand what went wrong
   * and how to fix it.
   */

  /**
   * Case 1: OpenAPI specification validation error
   *
   * This happens if the notion-openapi.json file is invalid or malformed.
   * This is a configuration error - the OpenAPI spec file needs to be fixed.
   *
   * Common causes:
   * - File is corrupted or incomplete
   * - File doesn't conform to OpenAPI 3.1 specification
   * - File has syntax errors (invalid JSON)
   */
  if (error instanceof ValidationError) {
    /**
     * Log to file with structured format
     *
     * We log validation errors with structured format so they can be analyzed
     * later. We include the validation error details so developers can see
     * exactly what's wrong with the OpenAPI spec.
     */
    logger.error("Invalid OpenAPI 3.1 specification", {
      component: "validation", // Identifies this as validation error
      errors: error.errors, // Include validation error details (array of error messages)
    });

    /**
     * Also log to console for immediate visibility
     *
     * Users need to see this immediately to fix the issue. We output the
     * error messages in a human-readable format so users can understand
     * what's wrong with the OpenAPI spec file.
     */
    console.error("Invalid OpenAPI 3.1 specification:");
    error.errors.forEach((err) => console.error(err));
  } else {
  /**
   * Case 2: Any other error (network, file system, etc.)
   *
   * This handles all other types of errors that might occur during startup:
   * - File system errors (can't read OpenAPI spec file)
   * - Network errors (can't bind to port, port already in use)
   * - Permission errors (can't create log directory)
   * - Unexpected errors (bugs, etc.)
   */
    /**
     * Log as critical since server failed to start
     *
     * We use CRITICAL level because the server failed to start - this is
     * a severe error that prevents the server from running. We include
     * the error object so the full stack trace is available in logs.
     */
    logger.critical(
      "Failed to start server",
      {
        component: "server", // Identifies this as server startup error
      },
      error as Error // The actual error object (for stack trace)
    );

    /**
     * Also log to console for immediate visibility
     *
     * Users need to see the error immediately to understand why the server
     * failed to start. We output the error message (and stack trace if available).
     */
    console.error("Error:", error);
  }

  /**
   * Exit with error code 1 to indicate failure
   *
   * We exit with code 1 (non-zero) to indicate failure. This allows:
   * - Shell scripts to detect the failure (if startServer.sh calls this)
   * - Process managers (PM2, systemd, etc.) to detect the failure
   * - CI/CD pipelines to detect the failure
   *
   * Exit code 0 would indicate success, which would be misleading if the
   * server failed to start.
   */
  process.exit(1);
});
