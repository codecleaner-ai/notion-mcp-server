import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware } from "../auth";

/**
 * Test suite for authentication middleware
 *
 * This suite tests the createAuthMiddleware function which validates
 * bearer token authentication for HTTP endpoints. The middleware checks
 * for "Authorization: Bearer <token>" header and compares it against the
 * server's configured auth token.
 */
describe("auth middleware", () => {
  // Mock Express request object - represents incoming HTTP request
  let mockRequest: Partial<Request>;
  // Mock Express response object - represents outgoing HTTP response
  let mockResponse: Partial<Response>;
  // Mock Express next function - called to pass control to next middleware
  let mockNext: NextFunction;
  // The middleware function being tested (created by createAuthMiddleware)
  let middleware: ReturnType<typeof createAuthMiddleware>;

  /**
   * Setup before each test
   *
   * Creates fresh mock objects for each test to ensure test isolation.
   * This prevents tests from interfering with each other.
   */
  beforeEach(() => {
    // Create a mock HTTP request with empty headers
    // The headers will be populated in individual tests
    mockRequest = {
      headers: {}, // HTTP headers (will contain Authorization header in tests)
      ip: "127.0.0.1", // Client IP address (for logging)
      path: "/mcp", // Request path (for logging)
    };

    // Create a mock HTTP response object
    // mockReturnThis() allows chaining: res.status(401).json(...)
    mockResponse = {
      status: vi.fn().mockReturnThis(), // HTTP status code setter (returns response for chaining)
      json: vi.fn().mockReturnThis(), // JSON response sender (returns response for chaining)
    };

    // Create a mock next() function
    // This is called when authentication succeeds to pass control to next middleware
    mockNext = vi.fn();
  });

  /**
   * Test suite for createAuthMiddleware function
   *
   * Tests various authentication scenarios:
   * - Valid token authentication (should succeed)
   * - Missing token (should fail with 401)
   * - Invalid token format (should fail with 401)
   * - Wrong token (should fail with 403)
   * - Edge cases (tokens with spaces, etc.)
   */
  describe("createAuthMiddleware", () => {
    /**
     * Test: Valid token authentication should succeed
     *
     * This is the happy path - when a client provides the correct
     * bearer token, the middleware should call next() to allow
     * the request to proceed to the next handler.
     */
    it("should call next() when valid token is provided", () => {
      // Arrange: Set up the server's expected auth token
      const authToken = "test-token-123";
      // Create the middleware with this token
      middleware = createAuthMiddleware(authToken);
      // Simulate a request with the correct Authorization header
      // Format: "Bearer <token>" where token matches server's token
      mockRequest.headers = {
        authorization: "Bearer test-token-123",
      };

      // Act: Call the middleware with the mock request/response
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Assert: Verify authentication succeeded
      // next() should be called to pass control to next middleware
      expect(mockNext).toHaveBeenCalled();
      // No error response should be sent (status() should not be called)
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    /**
     * Test: Missing authorization header should fail with 401
     *
     * When a client makes a request without any Authorization header,
     * the middleware should reject it with a 401 Unauthorized error.
     * This is a security requirement - all requests must be authenticated.
     */
    it("should return 401 when no authorization header is provided", () => {
      // Arrange: Set up server with an auth token
      const authToken = "test-token-123";
      middleware = createAuthMiddleware(authToken);
      // Simulate a request with NO Authorization header (empty headers)
      mockRequest.headers = {};

      // Act: Call the middleware
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Assert: Verify authentication failed with 401 Unauthorized
      // The middleware should send a 401 status code
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      // The response should be a JSON-RPC error object
      // This format is consistent with MCP protocol error responses
      expect(mockResponse.json).toHaveBeenCalledWith({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32001, // Custom error code for missing auth token
          message: "Unauthorized: Missing bearer token", // Human-readable error message
        },
        id: null, // No request ID since this is middleware-level error
      });
      // next() should NOT be called - request should be rejected
      expect(mockNext).not.toHaveBeenCalled();
    });

    /**
     * Test: Authorization header without "Bearer " prefix should fail
     *
     * The HTTP Bearer token authentication scheme requires the header
     * to be in the format "Bearer <token>". If the "Bearer " prefix is
     * missing, the token cannot be extracted and authentication fails.
     */
    it("should return 401 when authorization header is missing Bearer prefix", () => {
      // Arrange: Set up server with an auth token
      const authToken = "test-token-123";
      middleware = createAuthMiddleware(authToken);
      // Simulate a request with Authorization header but WITHOUT "Bearer " prefix
      // This is an invalid format - the middleware expects "Bearer <token>"
      mockRequest.headers = {
        authorization: "test-token-123", // Missing "Bearer " prefix - INVALID FORMAT
      };

      // Act: Call the middleware
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Assert: Verify authentication failed
      // Should return 401 because token cannot be extracted from invalid format
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      // next() should NOT be called - request should be rejected
      expect(mockNext).not.toHaveBeenCalled();
    });

    /**
     * Test: Wrong token should fail with 403 Forbidden
     *
     * When a client provides a token that doesn't match the server's
     * configured token, the middleware should reject it with a 403 Forbidden
     * error. This is different from 401 (missing token) - 403 means the
     * client tried to authenticate but provided invalid credentials.
     */
    it("should return 403 when token does not match", () => {
      // Arrange: Set up server with a specific auth token
      const authToken = "correct-token";
      middleware = createAuthMiddleware(authToken);
      // Simulate a request with a DIFFERENT token (wrong credentials)
      mockRequest.headers = {
        authorization: "Bearer wrong-token", // Token doesn't match server's token
      };

      // Act: Call the middleware
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Assert: Verify authentication failed with 403 Forbidden
      // 403 means the client provided credentials but they were invalid
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      // The response should be a JSON-RPC error object
      expect(mockResponse.json).toHaveBeenCalledWith({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32002, // Custom error code for invalid auth token
          message: "Forbidden: Invalid bearer token", // Human-readable error message
        },
        id: null, // No request ID since this is middleware-level error
      });
      // next() should NOT be called - request should be rejected
      expect(mockNext).not.toHaveBeenCalled();
    });

    /**
     * Test: Token extraction from Bearer format should work correctly
     *
     * This test verifies that the middleware correctly extracts the token
     * from the "Bearer <token>" format. The extraction logic splits the
     * header on spaces and takes the second element (index 1) as the token.
     * This is a fundamental requirement for Bearer token authentication.
     */
    it("should extract token correctly from Bearer format", () => {
      // Arrange: Set up server with a standard token
      const authToken = "my-secret-token";
      middleware = createAuthMiddleware(authToken);
      // Simulate a request with properly formatted Bearer token
      // Format: "Bearer <token>" where token is extracted by splitting on space
      mockRequest.headers = {
        authorization: "Bearer my-secret-token", // Standard Bearer format
      };

      // Act: Call the middleware
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      // Assert: Verify authentication succeeded
      // The middleware should extract "my-secret-token" from "Bearer my-secret-token"
      // and match it against the server's token
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
