import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { SessionManager } from "../session-manager";
import {
  createMCPPostHandler,
  createMCPGetHandler,
  createMCPDeleteHandler,
  type MCPHandlersConfig,
} from "../mcp-handlers";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MCPProxy } from "../../openapi-mcp-server/mcp/proxy";

/**
 * Mock the logger module to prevent actual logging during tests
 *
 * This ensures tests run silently and don't pollute test output with log messages.
 * We mock all logger methods (debug, warning, error) as no-op functions.
 */
vi.mock("../../utils/logger", () => ({
  logger: {
    debug: vi.fn(), // Mock debug logging (no-op during tests)
    warning: vi.fn(), // Mock warning logging (no-op during tests)
    error: vi.fn(), // Mock error logging (no-op during tests)
  },
}));

/**
 * Test suite for MCP route handlers
 *
 * This suite tests the HTTP route handlers for the MCP protocol endpoints:
 * - POST /mcp: Client-to-server communication (tool calls, initialization, etc.)
 * - GET /mcp: Server-to-client notifications (long-polling/streaming)
 * - DELETE /mcp: Session termination
 *
 * These handlers manage MCP protocol sessions and route requests to the correct
 * transport instances based on session IDs.
 */
describe("mcp-handlers", () => {
  // Mock Express request object - represents incoming HTTP request
  let mockRequest: Partial<Request>;
  // Mock Express response object - represents outgoing HTTP response
  let mockResponse: Partial<Response>;
  // Session manager instance - manages MCP session storage and token lookup
  let sessionManager: SessionManager;
  // Mock MCP proxy - bridges MCP protocol to Notion API
  let mockProxy: Partial<MCPProxy>;
  // Mock MCP transport - handles MCP protocol communication over HTTP
  let mockTransport: StreamableHTTPServerTransport;

  /**
   * Setup before each test
   *
   * Creates fresh mock objects and a new SessionManager for each test.
   * This ensures test isolation - each test starts with a clean state.
   */
  beforeEach(() => {
    // Create a new SessionManager instance for each test
    // This ensures no session state leaks between tests
    sessionManager = new SessionManager();

    // Create a mock HTTP request object
    // This simulates an incoming HTTP request
    mockRequest = {
      headers: {}, // HTTP headers (will contain mcp-session-id, x-notion-token, etc.)
      body: {}, // Request body (will contain JSON-RPC message in tests)
      method: "POST", // HTTP method (POST for client-to-server, GET for notifications)
      path: "/mcp", // Request path (always /mcp for MCP endpoints)
    };

    // Create a mock HTTP response object
    // mockReturnThis() allows method chaining: res.status(400).json(...)
    mockResponse = {
      status: vi.fn().mockReturnThis(), // HTTP status code setter (returns response for chaining)
      json: vi.fn().mockReturnThis(), // JSON response sender (returns response for chaining)
      send: vi.fn().mockReturnThis(), // Plain text response sender (returns response for chaining)
      headersSent: false, // Flag indicating if response headers have been sent
    };

    // Create a mock MCP transport object
    // The transport handles MCP protocol communication over HTTP
    mockTransport = {
      sessionId: "test-session-1", // Unique session identifier
      handleRequest: vi.fn().mockResolvedValue(undefined), // Mock method that processes MCP requests
      onclose: undefined, // Callback fired when session closes (not used in these tests)
    } as unknown as StreamableHTTPServerTransport;

    // Create a mock MCP proxy object
    // The proxy bridges MCP protocol to Notion API
    mockProxy = {
      setSessionTokenLookup: vi.fn(), // Mock method to set token lookup function for multi-tenancy
      connect: vi.fn().mockResolvedValue(undefined), // Mock method to connect proxy to transport
    };
  });

  /**
   * Test suite for GET /mcp handler (server-to-client notifications)
   *
   * The GET handler is used for server-to-client notifications via long-polling
   * or streaming. Clients poll this endpoint to receive notifications from the server.
   * This handler requires a valid session ID to route the request to the correct transport.
   */
  describe("createMCPGetHandler", () => {
    /**
     * Test: Missing session ID should return 400 Bad Request
     *
     * When a client makes a GET request without providing a session ID,
     * the handler cannot determine which transport to use, so it should
     * reject the request with a 400 error.
     */
    it("should return 400 when session ID is missing", async () => {
      // Arrange: Create the handler and simulate a request without session ID
      const handler = createMCPGetHandler(sessionManager);
      mockRequest.headers = {}; // No mcp-session-id header

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because it cannot route the request without a session ID
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The error message should indicate the session ID is missing or invalid
      expect(mockResponse.send).toHaveBeenCalledWith(
        "Invalid or missing session ID"
      );
    });

    /**
     * Test: Non-existent session should return 400 Bad Request
     *
     * When a client provides a session ID that doesn't exist in the session manager,
     * the handler cannot find the corresponding transport, so it should reject
     * the request with a 400 error.
     */
    it("should return 400 when session does not exist", async () => {
      // Arrange: Create the handler and simulate a request with invalid session ID
      const handler = createMCPGetHandler(sessionManager);
      mockRequest.headers = {
        "mcp-session-id": "non-existent-session", // Session ID that doesn't exist
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because the session doesn't exist
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The error message should indicate the session ID is invalid
      expect(mockResponse.send).toHaveBeenCalledWith(
        "Invalid or missing session ID"
      );
    });

    /**
     * Test: Valid session should route request to transport
     *
     * When a client provides a valid session ID, the handler should retrieve
     * the corresponding transport and delegate the request handling to it.
     * This is the happy path for GET requests.
     */
    it("should call transport.handleRequest for valid session", async () => {
      // Arrange: Store a transport in the session manager and create the handler
      sessionManager.storeTransport("test-session-1", mockTransport);
      const handler = createMCPGetHandler(sessionManager);
      mockRequest.headers = {
        "mcp-session-id": "test-session-1", // Valid session ID
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify the request was delegated to the transport
      // The transport's handleRequest method should be called with the request and response
      // This allows the transport to handle the long-polling/streaming logic
      expect(mockTransport.handleRequest).toHaveBeenCalledWith(
        mockRequest,
        mockResponse
      );
    });
  });

  /**
   * Test suite for DELETE /mcp handler (session termination)
   *
   * The DELETE handler allows clients to explicitly terminate a session.
   * This cleans up the session and releases resources. The transport's
   * onclose callback will be triggered to remove it from the session manager.
   */
  describe("createMCPDeleteHandler", () => {
    /**
     * Test: Missing session ID should return 400 Bad Request
     *
     * When a client makes a DELETE request without providing a session ID,
     * the handler cannot determine which session to terminate, so it should
     * reject the request with a 400 error.
     */
    it("should return 400 when session ID is missing", async () => {
      // Arrange: Create the handler and simulate a request without session ID
      const handler = createMCPDeleteHandler(sessionManager);
      mockRequest.headers = {}; // No mcp-session-id header

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because it cannot identify which session to terminate
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The error message should indicate the session ID is missing or invalid
      expect(mockResponse.send).toHaveBeenCalledWith(
        "Invalid or missing session ID"
      );
    });

    /**
     * Test: Non-existent session should return 400 Bad Request
     *
     * When a client provides a session ID that doesn't exist, the handler
     * cannot find the session to terminate, so it should reject the request
     * with a 400 error.
     */
    it("should return 400 when session does not exist", async () => {
      // Arrange: Create the handler and simulate a request with invalid session ID
      const handler = createMCPDeleteHandler(sessionManager);
      mockRequest.headers = {
        "mcp-session-id": "non-existent-session", // Session ID that doesn't exist
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because the session doesn't exist
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The error message should indicate the session ID is invalid
      expect(mockResponse.send).toHaveBeenCalledWith(
        "Invalid or missing session ID"
      );
    });

    /**
     * Test: Valid session should route termination request to transport
     *
     * When a client provides a valid session ID, the handler should retrieve
     * the corresponding transport and delegate the termination request to it.
     * The transport will handle closing the session and triggering cleanup.
     */
    it("should call transport.handleRequest for valid session", async () => {
      // Arrange: Store a transport in the session manager and create the handler
      sessionManager.storeTransport("test-session-1", mockTransport);
      const handler = createMCPDeleteHandler(sessionManager);
      mockRequest.headers = {
        "mcp-session-id": "test-session-1", // Valid session ID
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify the termination request was delegated to the transport
      // The transport's handleRequest method should be called with the request and response
      // This allows the transport to handle session termination and cleanup
      expect(mockTransport.handleRequest).toHaveBeenCalledWith(
        mockRequest,
        mockResponse
      );
    });
  });

  /**
   * Test suite for POST /mcp handler (client-to-server communication)
   *
   * The POST handler is the most complex handler - it handles:
   * - Session initialization (new sessions)
   * - Existing session reuse (subsequent requests in a session)
   * - Tool calls, resource queries, and other MCP protocol messages
   * - Multi-tenant token management (X-Notion-Token header)
   *
   * This handler has three main code paths:
   * 1. Reuse existing session (if session ID provided and exists)
   * 2. Initialize new session (if no session ID and request is "initialize")
   * 3. Reject invalid request (if session ID provided but doesn't exist, or no session ID and not initialize)
   */
  describe("createMCPPostHandler", () => {
    // Configuration object passed to createMCPPostHandler
    let config: MCPHandlersConfig;
    // The handler function created by createMCPPostHandler
    let handler: ReturnType<typeof createMCPPostHandler>;

    /**
     * Setup before each POST handler test
     *
     * Creates a fresh handler configuration for each test.
     * The initProxy function is mocked to return our mockProxy.
     */
    beforeEach(() => {
      // Create handler configuration
      config = {
        specPath: "/path/to/spec.json", // Path to OpenAPI specification file
        baseUrl: undefined, // Optional base URL override (not used in tests)
        sessionManager, // Session manager instance (shared across tests)
        // Mock function that creates and returns an MCP proxy
        // This is called when initializing new sessions
        initProxy: vi.fn().mockResolvedValue(mockProxy as MCPProxy),
      };
      // Create the handler with this configuration
      handler = createMCPPostHandler(config);
    });

    /**
     * Test: Session ID provided but transport not found should return 400
     *
     * This tests the error case where a client provides a session ID in the
     * request header, but that session doesn't exist in the session manager.
     * This can happen if:
     * - The session was closed/expired
     * - The session ID is invalid/corrupted
     * - There's a race condition (session not yet initialized)
     *
     * The handler should reject the request with a 400 Bad Request error.
     */
    it("should return 400 when session ID provided but transport not found", async () => {
      // Arrange: Simulate a request with a session ID that doesn't exist
      mockRequest.headers = {
        "mcp-session-id": "non-existent-session", // Session ID that's not in session manager
      };
      // Simulate a JSON-RPC request (e.g., tools/list)
      mockRequest.body = {
        jsonrpc: "2.0", // JSON-RPC version
        method: "tools/list", // MCP method name
        id: 1, // Request ID for matching response
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because the session doesn't exist
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The response should be a JSON-RPC error object
      // This format is consistent with MCP protocol error responses
      expect(mockResponse.json).toHaveBeenCalledWith({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32000, // Custom error code for invalid request
          message: "Bad Request: No valid session ID provided", // Human-readable error message
        },
        id: null, // No request ID since this is a handler-level error
      });
    });

    /**
     * Test: No session ID and not initialize request should return 400
     *
     * This tests the error case where a client makes a request without a session ID,
     * but the request is NOT an "initialize" request. In the MCP protocol, only
     * "initialize" requests can create new sessions. All other requests require
     * an existing session ID.
     *
     * The handler should reject the request with a 400 Bad Request error.
     */
    it("should return 400 when no session ID and not initialize request", async () => {
      // Arrange: Simulate a request without session ID and not an initialize request
      mockRequest.headers = {}; // No mcp-session-id header
      // Simulate a JSON-RPC request that is NOT "initialize"
      mockRequest.body = {
        jsonrpc: "2.0", // JSON-RPC version
        method: "tools/list", // MCP method (NOT "initialize")
        id: 1, // Request ID
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify request was rejected with 400 Bad Request
      // The handler should return 400 because:
      // 1. No session ID provided (cannot reuse existing session)
      // 2. Request is not "initialize" (cannot create new session)
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      // The response should be a JSON-RPC error object
      expect(mockResponse.json).toHaveBeenCalledWith({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32000, // Custom error code for invalid request
          message: "Bad Request: No valid session ID provided", // Human-readable error message
        },
        id: null, // No request ID since this is a handler-level error
      });
    });

    /**
     * Test: Existing session should be reused
     *
     * This tests the happy path for subsequent requests in an existing session.
     * When a client provides a valid session ID, the handler should:
     * 1. Look up the transport for that session
     * 2. Delegate the request to that transport
     * 3. The transport processes the MCP protocol message
     *
     * This is the most common code path after session initialization.
     */
    it("should reuse existing session transport", async () => {
      // Arrange: Store a transport in the session manager (simulating an existing session)
      sessionManager.storeTransport("existing-session", mockTransport);
      // Simulate a request with a valid session ID
      mockRequest.headers = {
        "mcp-session-id": "existing-session", // Valid session ID
      };
      // Simulate a JSON-RPC request (e.g., tools/list, tools/call, etc.)
      mockRequest.body = {
        jsonrpc: "2.0", // JSON-RPC version
        method: "tools/list", // MCP method name
        id: 1, // Request ID
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify the request was delegated to the transport
      // The transport's handleRequest method should be called with:
      // - The request object (contains headers, body, etc.)
      // - The response object (for sending the response)
      // - The request body (the JSON-RPC message)
      expect(mockTransport.handleRequest).toHaveBeenCalledWith(
        mockRequest,
        mockResponse,
        mockRequest.body
      );
    });

    /**
     * Test: Token update for existing session should work
     *
     * This tests the multi-tenant feature - when a client provides an
     * X-Notion-Token header with an existing session, the handler should
     * update the session's Notion token. This allows changing the Notion
     * workspace associated with a session mid-session.
     *
     * This is useful for scenarios where:
     * - A user switches workspaces during a conversation
     * - A session needs to access multiple workspaces
     * - Token rotation/refresh is needed
     */
    it("should update token when provided with existing session", async () => {
      // Arrange: Store a transport with an initial token
      sessionManager.storeTransport(
        "existing-session",
        mockTransport,
        "old-token"
      );
      // Simulate a request with a valid session ID AND a new Notion token
      mockRequest.headers = {
        "mcp-session-id": "existing-session", // Valid session ID
        "x-notion-token": "new-token", // NEW Notion token (multi-tenant feature)
      };
      // Simulate a JSON-RPC request
      mockRequest.body = {
        jsonrpc: "2.0", // JSON-RPC version
        method: "tools/list", // MCP method name
        id: 1, // Request ID
      };

      // Act: Call the handler
      await handler(mockRequest as Request, mockResponse as Response);

      // Assert: Verify the token was updated in the session manager
      // The session should now have "new-token" instead of "old-token"
      // This allows subsequent tool calls in this session to use the new token
      expect(sessionManager.getToken("existing-session")).toBe("new-token");
    });

    /**
     * Note on testing initialize request flow:
     *
     * Testing the "initialize" request flow (creating new sessions) is more complex
     * because it involves:
     * - Creating a new StreamableHTTPServerTransport instance
     * - Setting up the onsessioninitialized callback
     * - Calling initProxy() and proxy.connect()
     * - Handling the asynchronous session initialization
     *
     * This requires extensive mocking of the MCP SDK, which makes it a better
     * candidate for integration tests rather than unit tests. Integration tests
     * can test the full flow with real MCP SDK components.
     *
     * For unit tests, we focus on:
     * - Error handling (missing/invalid session IDs)
     * - Session reuse logic
     * - Token update logic
     * - Request routing to transports
     */
  });
});
