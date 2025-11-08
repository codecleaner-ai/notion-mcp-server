/**
 * MCP Route Handlers for Notion MCP Server
 *
 * This module contains the HTTP route handlers for MCP protocol endpoints:
 * - POST /mcp - Client-to-server communication (tool calls, initialization, etc.)
 * - GET /mcp - Server-to-client notifications (long-polling/streaming)
 * - DELETE /mcp - Session termination
 *
 * These handlers manage the MCP protocol lifecycle:
 * 1. Session initialization (POST with initialize request)
 * 2. Request routing to correct session (POST with session ID)
 * 3. Server-to-client notifications (GET with session ID)
 * 4. Session cleanup (DELETE with session ID)
 *
 * The handlers also support multi-tenant functionality by extracting
 * X-Notion-Token headers and associating them with sessions.
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger";
import { SessionManager } from "./session-manager";
import type { MCPProxy } from "../openapi-mcp-server/mcp/proxy";

/**
 * Configuration interface for MCP route handlers
 *
 * This interface defines the dependencies and configuration needed to create
 * MCP route handlers. It's passed to the handler factory functions to configure
 * their behavior.
 */
export interface MCPHandlersConfig {
  /** Path to the OpenAPI specification file (defines Notion API endpoints) */
  specPath: string;
  /** Optional base URL override for Notion API (for testing or custom endpoints) */
  baseUrl?: string;
  /** Session manager instance (manages MCP sessions and Notion tokens) */
  sessionManager: SessionManager;
  /** Function to initialize an MCP proxy (creates proxy instance with OpenAPI spec) */
  initProxy: (specPath: string, baseUrl?: string) => Promise<MCPProxy>;
}

/**
 * Create POST /mcp handler for client-to-server communication
 *
 * This handler processes MCP protocol requests from clients. It handles three main scenarios:
 * 1. Existing session reuse - Route request to existing transport
 * 2. New session initialization - Create new transport and proxy
 * 3. Invalid request - Return error response
 *
 * The handler also extracts X-Notion-Token headers for multi-tenant support,
 * allowing different sessions to use different Notion workspaces.
 *
 * @param config - Configuration object with specPath, baseUrl, sessionManager, and initProxy
 * @returns Express route handler function that processes POST /mcp requests
 */
export function createMCPPostHandler(config: MCPHandlersConfig) {
  /**
   * Extract configuration from config object
   *
   * We destructure the config to get the values we need. This makes the code
   * cleaner and allows us to use shorter variable names in the handler.
   */
  const { specPath, baseUrl, sessionManager, initProxy } = config;

  /**
   * Return the Express route handler function
   *
   * This function will be called by Express when a POST request is made to /mcp.
   * It's an async function because we need to await proxy initialization and
   * transport operations.
   */
  return async (req: express.Request, res: express.Response) => {
    /**
     * Wrap entire handler in try-catch for error handling
     *
     * Any errors that occur during request processing will be caught here,
     * logged, and returned as a JSON-RPC error response. This prevents the
     * server from crashing and provides useful error information to clients.
     */
    try {
      /**
       * Extract and log incoming request details for debugging
       *
       * We log detailed information about the incoming request to help diagnose
       * issues. This includes:
       * - Session ID from headers (if present)
       * - Whether a session ID was provided
       * - The MCP method being called (from request body)
       * - All active sessions (for debugging session routing)
       * - Session-related headers (for debugging header parsing)
       * - Raw header value (to catch encoding/parsing issues)
       *
       * This logging is at DEBUG level, so it only appears when DEBUG_MODE is enabled.
       */
      // CRITICAL DEBUG: Log ALL headers to see what Express actually receives
      // This helps diagnose why mcp-session-id header isn't being read
      const allRequestHeaders = Object.keys(req.headers).map((key) => ({
        key,
        value: req.headers[key],
      }));

      const incomingSessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;

      // Also try alternative ways to access the header (Express might normalize differently)
      const sessionIdViaGet = req.get("mcp-session-id");
      const sessionIdViaLowercase = req.headers["mcp-session-id"];

      // Find all headers that contain "session" (case-insensitive)
      // This helps debug header parsing issues
      const allHeaders = Object.keys(req.headers).filter((h) =>
        h.toLowerCase().includes("session")
      );

      logger.debug("Incoming MCP request - HEADER DEBUG", {
        component: "mcp", // Identifies this as MCP-related logging
        // All headers received by Express (for debugging)
        allHeaders: allRequestHeaders,
        // Session ID access attempts
        sessionId_direct: incomingSessionId, // req.headers["mcp-session-id"]
        sessionId_viaGet: sessionIdViaGet, // req.get("mcp-session-id")
        sessionId_viaLowercase: sessionIdViaLowercase, // Alternative access
        hasSessionId: !!incomingSessionId, // Boolean: does session ID exist?
        requestMethod: req.body?.method, // MCP method (e.g., "initialize", "tools/list")
        availableSessions: sessionManager.getActiveSessions(), // All active session IDs
        sessionHeaders: allHeaders, // Headers containing "session"
        rawHeaderValue: req.headers["mcp-session-id"], // Raw header value (for debugging)
        // Additional debugging: show all header keys
        allHeaderKeys: Object.keys(req.headers),
      });

      /**
       * Extract custom Notion token from HTTP request headers
       *
       * The X-Notion-Token header allows clients to specify which Notion workspace
       * to use for this session. This enables multi-tenant support - different sessions
       * can use different Notion workspaces by providing different tokens.
       *
       * If this header is not provided, the session will use the NOTION_TOKEN
       * environment variable (backward compatibility with single-tenant mode).
       */
      const customNotionToken = req.headers["x-notion-token"] as
        | string
        | undefined;

      /**
       * Extract session ID from request headers
       *
       * The MCP protocol uses the "mcp-session-id" header to identify which session
       * a request belongs to. This allows multiple concurrent sessions to be handled
       * by the same server instance.
       *
       * - If sessionId is present: This is a request for an existing session
       * - If sessionId is absent: This might be a new session initialization
       *
       * The session ID is generated by the MCP SDK during session initialization
       * and returned to the client in the response headers.
       */
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      /**
       * Transport variable to hold the MCP transport instance
       *
       * This will be set to either:
       * - An existing transport (if reusing a session)
       * - A new transport (if initializing a session)
       *
       * The transport handles MCP protocol communication over HTTP.
       */
      let transport: StreamableHTTPServerTransport;

      /**
       * Case 1: Existing session - reuse the transport
       *
       * If a session ID is provided AND we have a transport stored for that session,
       * we reuse the existing transport. This is the most common case after session
       * initialization - subsequent requests in the same session reuse the transport.
       *
       * This allows:
       * - Multiple requests within the same session
       * - State to be maintained across requests
       * - Efficient resource usage (no need to recreate transport for each request)
       */
      if (sessionId && sessionManager.hasSession(sessionId)) {
        /**
         * Log that we're reusing an existing session
         *
         * This helps track session reuse patterns and diagnose routing issues.
         */
        logger.debug("Reusing existing session transport", {
          component: "mcp",
          sessionId,
        });
        /**
         * Retrieve the existing transport for this session
         *
         * We use the non-null assertion operator (!) because we've already verified
         * the session exists with hasSession(). getTransport() will return the
         * transport, not undefined, in this case.
         */
        transport = sessionManager.getTransport(sessionId)!;

        /**
         * Update Notion token if provided (allows changing token mid-session)
         *
         * If the client provides a new X-Notion-Token header, we update the
         * session's token. This allows switching Notion workspaces during a session
         * without creating a new session. This is useful for:
         * - Users switching workspaces mid-conversation
         * - Token rotation/refresh
         * - Testing different workspaces
         */
        if (customNotionToken) {
          sessionManager.updateToken(sessionId, customNotionToken);
        }
      } else if (!sessionId && isInitializeRequest(req.body)) {
        /**
         * Case 2: New session initialization
         *
         * If no session ID is provided AND the request is an "initialize" request,
         * we need to create a new session. This happens when a client first connects
         * to the MCP server.
         *
         * The initialization process:
         * 1. Create a new StreamableHTTPServerTransport instance
         * 2. Set up callbacks for session lifecycle events
         * 3. Initialize the MCP proxy (connects transport to Notion API)
         * 4. Connect the proxy to the transport
         */
        /**
         * Create a new Streamable HTTP transport instance
         *
         * The StreamableHTTPServerTransport handles MCP protocol communication
         * over HTTP. It manages:
         * - Session ID generation
         * - Request/response routing
         * - Protocol message parsing
         * - Server-sent events (SSE) for notifications
         *
         * We configure it with:
         * - sessionIdGenerator: Function that generates unique session IDs
         * - onsessioninitialized: Callback fired when session is ready
         */
        transport = new StreamableHTTPServerTransport({
          /**
           * Generate a unique UUID for this session
           *
           * The sessionIdGenerator function is called by the transport to create
           * a unique identifier for this session. We use randomUUID() to ensure
           * uniqueness across all sessions.
           *
           * This session ID will be:
           * - Returned to the client in response headers
           * - Used by the client in subsequent requests (mcp-session-id header)
           * - Used by the server to route requests to the correct transport
           */
          sessionIdGenerator: () => randomUUID(),

          /**
           * Callback fired when session is initialized
           *
           * This callback is called by the transport after the session has been
           * fully initialized. At this point, the sessionId is available and we
           * can store the transport in our session manager.
           *
           * Important: This callback is called asynchronously, which means the
           * session ID might not be immediately available in the response headers.
           * This is why we need retry logic in test scripts.
           *
           * @param sessionId - The unique session ID generated by the transport
           */
          onsessioninitialized: (sessionId) => {
            /**
             * Log when callback fires to diagnose race conditions
             *
             * This helps track when the callback is fired relative to when the
             * response is sent. If there's a race condition, we'll see the callback
             * fire after the response, which explains why subsequent requests fail.
             */
            logger.debug("Session initialized callback fired", {
              component: "mcp",
              sessionId,
              transportStored: sessionManager.hasSession(sessionId), // Should be false initially
            });

            /**
             * Store the transport in our session manager
             *
             * This associates the sessionId with the transport, allowing us to
             * retrieve it later when routing requests. We also store the Notion
             * token if one was provided, enabling multi-tenant support.
             *
             * After this call, the transport is available for subsequent requests
             * in this session.
             */
            sessionManager.storeTransport(
              sessionId,
              transport,
              customNotionToken
            );

            /**
             * Log that transport was stored
             *
             * This confirms the storage operation completed and shows how many
             * concurrent sessions are now active.
             */
            logger.debug("Transport stored in map", {
              component: "mcp",
              sessionId,
              transportCount: sessionManager.getActiveSessions().length,
            });
          },
        });

        /**
         * Set up cleanup callback when session is closed
         *
         * The onclose callback is fired when the session is terminated (e.g., client
         * disconnects, session timeout, explicit DELETE request). We use this to
         * clean up the session from our session manager, preventing memory leaks.
         */
        transport.onclose = () => {
          /**
           * Remove session from session manager
           *
           * We check if transport.sessionId exists before removing, because the
           * session might have been removed already or the transport might not
           * have a sessionId yet (edge case during initialization).
           */
          if (transport.sessionId) {
            sessionManager.removeSession(transport.sessionId);
          }
        };

        /**
         * Initialize the MCP proxy for this transport
         *
         * The proxy is the bridge between the MCP protocol and the Notion API.
         * It:
         * - Parses the OpenAPI specification to understand Notion API endpoints
         * - Converts MCP tool calls to Notion API requests
         * - Converts Notion API responses to MCP protocol messages
         *
         * We await this because it's an async operation (reads the OpenAPI spec file).
         */
        const proxy = await initProxy(specPath, baseUrl);

        /**
         * Pass token lookup function to proxy for multi-tenant support
         *
         * The proxy needs a way to get the Notion token for a given session ID
         * when making API calls. We provide a function that looks up tokens from
         * the session manager. This allows:
         * - Each session to use a different Notion token
         * - Dynamic token updates during a session
         * - Fallback to NOTION_TOKEN env var if no session token exists
         */
        proxy.setSessionTokenLookup(sessionManager.getTokenLookup());

        /**
         * Connect the proxy to the transport
         *
         * This establishes the MCP protocol connection. After this call:
         * - The proxy can receive MCP messages from the transport
         * - The proxy can send MCP responses through the transport
         * - The session is fully initialized and ready to handle requests
         *
         * We await this because it's an async operation (sets up internal connections).
         */
        await proxy.connect(transport);
      } else {
        /**
         * Case 3: Invalid request - reject with error
         *
         * This case handles invalid requests that cannot be processed:
         * - Request has a session ID but no matching transport exists
         *   (session expired, invalid ID, or race condition)
         * - Request is not an "initialize" request but has no session ID
         *   (client forgot to include session ID or trying to use uninitialized session)
         *
         * In both cases, we return a 400 Bad Request error in JSON-RPC format.
         */
        /**
         * Log why the request was rejected
         *
         * We log different messages depending on the specific error case.
         * This helps diagnose issues:
         * - If sessionId exists but transport doesn't: Session might have expired
         * - If no sessionId and not initialize: Client error (missing session ID)
         *
         * We include available sessions in the log to help debug session routing issues.
         */
        if (sessionId) {
          logger.warning("Session ID provided but transport not found", {
            component: "mcp",
            sessionId, // The session ID that wasn't found
            availableSessions: sessionManager.getActiveSessions(), // What sessions do exist?
            requestMethod: req.body?.method, // What was the client trying to do?
          });
        } else {
          logger.warning("No session ID provided for non-initialize request", {
            component: "mcp",
            requestMethod: req.body?.method, // What was the client trying to do?
          });
        }

        /**
         * Return 400 Bad Request with JSON-RPC error format
         *
         * We use JSON-RPC error format because the MCP protocol is based on JSON-RPC.
         * The error response includes:
         * - jsonrpc: "2.0" (JSON-RPC version)
         * - error: Error object with code and message
         * - id: null (no request ID since this is a handler-level error)
         *
         * Error code -32000 is a custom error code for invalid requests.
         */
        res.status(400).json({
          jsonrpc: "2.0", // JSON-RPC version
          error: {
            code: -32000, // Custom error code for invalid request
            message: "Bad Request: No valid session ID provided", // Human-readable error
          },
          id: null, // No request ID (handler-level error, not JSON-RPC level)
        });
        return; // Stop processing - don't continue to transport handling
      }

      /**
       * Handle the MCP request
       *
       * At this point, we have a valid transport (either reused or newly created).
       * We delegate the actual request processing to the transport, which:
       * - Parses the MCP protocol message from req.body
       * - Routes it to the appropriate handler (tool call, resource query, etc.)
       * - Sends the response back to the client
       *
       * We log the request for debugging (only if DEBUG_MODE is enabled).
       */
      logger.debug("Processing MCP request", {
        component: "mcp",
        sessionId: transport.sessionId, // Use transport's sessionId (more reliable)
        method: req.method, // HTTP method (should be "POST")
        path: req.path, // Request path (should be "/mcp")
      });

      /**
       * Delegate request handling to the transport
       *
       * The transport's handleRequest method processes the MCP protocol message.
       * It:
       * - Parses the JSON-RPC message from req.body
       * - Routes it to the appropriate MCP handler (via the proxy)
       * - Sends the response back through res
       *
       * We pass:
       * - req: The Express request object (contains headers, body, etc.)
       * - res: The Express response object (for sending the response)
       * - req.body: The JSON-RPC message body (MCP protocol message)
       *
       * We await this because it's an async operation (may involve API calls).
       */
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      /**
       * Error handling: Catch any errors during request processing
       *
       * If any error occurs during request processing (transport creation, proxy
       * initialization, request handling, etc.), we catch it here and return an
       * appropriate error response. This prevents the server from crashing and
       * provides useful error information to the client.
       */
      logger.error(
        "Error handling MCP request",
        {
          component: "mcp",
          sessionId: req.headers["mcp-session-id"] as string | undefined, // Session ID from headers
          method: req.method, // HTTP method
          path: req.path, // Request path
        },
        error as Error // The actual error object (for stack trace)
      );

      /**
       * Only send error response if headers haven't been sent yet
       *
       * If the transport has already started sending a response (e.g., streaming
       * response), we can't send another response. Attempting to do so would cause
       * an error: "Cannot set headers after they are sent to the client".
       *
       * We check res.headersSent to avoid this error. If headers were already sent,
       * we just log the error and let the transport handle the error response.
       */
      if (!res.headersSent) {
        /**
         * Return 500 Internal Server Error with JSON-RPC error format
         *
         * This indicates a server-side error (not a client error like 400).
         * The error code -32603 is the standard JSON-RPC internal error code.
         */
        res.status(500).json({
          jsonrpc: "2.0", // JSON-RPC version
          error: {
            code: -32603, // JSON-RPC internal error code
            message: "Internal server error", // Generic error message (details in logs)
          },
          id: null, // No request ID (handler-level error)
        });
      }
    }
  };
}

/**
 * Create GET /mcp handler for server-to-client notifications
 *
 * The GET endpoint is used for server-to-client notifications via long-polling
 * or server-sent events (SSE). Clients poll this endpoint to receive notifications
 * from the server (e.g., tool execution progress, resource updates).
 *
 * This handler:
 * 1. Validates the session ID
 * 2. Retrieves the transport for that session
 * 3. Delegates to the transport for streaming/notification handling
 *
 * @param sessionManager - The session manager instance (manages active sessions)
 * @returns Express route handler function that processes GET /mcp requests
 */
export function createMCPGetHandler(sessionManager: SessionManager) {
  return async (req: express.Request, res: express.Response) => {
    /**
     * Extract session ID from request headers
     *
     * The client must provide the mcp-session-id header to identify which
     * session this notification request belongs to. Without it, we can't route
     * the request to the correct transport.
     */
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    /**
     * Validate that we have a valid session
     *
     * We check:
     * - sessionId exists (not undefined)
     * - sessionId corresponds to an active session (hasSession returns true)
     *
     * If either check fails, we return a 400 error. This prevents:
     * - Requests to non-existent sessions
     * - Requests with invalid/malformed session IDs
     */
    if (!sessionId || !sessionManager.hasSession(sessionId)) {
      /**
       * Return 400 Bad Request for invalid session
       *
       * We use a plain text response (not JSON-RPC) because this is a handler-level
       * error, not an MCP protocol error. The client should handle this as a
       * connection/session error, not an MCP protocol error.
       */
      res.status(400).send("Invalid or missing session ID");
      return; // Stop processing
    }

    /**
     * Get the transport for this session
     *
     * We use the non-null assertion operator (!) because we've already verified
     * the session exists with hasSession(). getTransport() will return the
     * transport, not undefined, in this case.
     */
    const transport = sessionManager.getTransport(sessionId)!;

    /**
     * Handle the notification request
     *
     * We delegate to the transport's handleRequest method, which handles:
     * - Server-sent events (SSE) setup
     * - Long-polling logic
     * - Streaming notifications to the client
     * - Connection management
     *
     * The transport will keep the connection open and stream notifications
     * as they become available.
     */
    await transport.handleRequest(req, res);
  };
}

/**
 * Create DELETE /mcp handler for session termination
 *
 * The DELETE endpoint allows clients to explicitly terminate a session.
 * This is useful for:
 * - Graceful shutdown (client wants to close connection cleanly)
 * - Resource cleanup (free up server resources)
 * - Session management (client switching sessions)
 *
 * When a session is terminated:
 * - The transport's onclose callback is fired
 * - The session is removed from the session manager
 * - Resources (transport, token) are cleaned up
 *
 * @param sessionManager - The session manager instance (manages active sessions)
 * @returns Express route handler function that processes DELETE /mcp requests
 */
export function createMCPDeleteHandler(sessionManager: SessionManager) {
  return async (req: express.Request, res: express.Response) => {
    /**
     * Extract session ID from request headers
     *
     * The client must provide the mcp-session-id header to identify which
     * session to terminate. Without it, we can't determine which session to close.
     */
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    /**
     * Validate that we have a valid session
     *
     * We check:
     * - sessionId exists (not undefined)
     * - sessionId corresponds to an active session (hasSession returns true)
     *
     * If either check fails, we return a 400 error. This prevents:
     * - Attempts to terminate non-existent sessions
     * - Requests with invalid/malformed session IDs
     */
    if (!sessionId || !sessionManager.hasSession(sessionId)) {
      /**
       * Return 400 Bad Request for invalid session
       *
       * We use a plain text response (not JSON-RPC) because this is a handler-level
       * error, not an MCP protocol error. The client should handle this as a
       * connection/session error.
       */
      res.status(400).send("Invalid or missing session ID");
      return; // Stop processing
    }

    /**
     * Get the transport for this session
     *
     * We use the non-null assertion operator (!) because we've already verified
     * the session exists with hasSession(). getTransport() will return the
     * transport, not undefined, in this case.
     */
    const transport = sessionManager.getTransport(sessionId)!;

    /**
     * Handle the termination request
     *
     * We delegate to the transport's handleRequest method, which:
     * - Processes the DELETE request according to MCP protocol
     * - Closes the session
     * - Fires the onclose callback (which removes the session from session manager)
     * - Sends the termination response to the client
     *
     * After this call, the session is fully terminated and cleaned up.
     */
    await transport.handleRequest(req, res);
  };
}
