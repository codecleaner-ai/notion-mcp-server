import { describe, expect, it, beforeEach } from "vitest";
import { SessionManager } from "../session-manager";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Test suite for SessionManager class
 *
 * The SessionManager is responsible for managing MCP protocol sessions, including:
 * - Storing and retrieving transport instances by session ID
 * - Associating Notion tokens with sessions (multi-tenant support)
 * - Updating tokens for existing sessions
 * - Cleaning up sessions when they're removed
 * - Providing token lookup functions for the MCP proxy
 *
 * This test suite verifies that all session management operations work correctly
 * and that sessions are properly isolated from each other.
 */
describe("SessionManager", () => {
  // SessionManager instance being tested - manages session storage
  let sessionManager: SessionManager;
  // Mock MCP transport object - represents a single MCP session transport
  let mockTransport: StreamableHTTPServerTransport;

  /**
   * Setup before each test
   *
   * Creates a fresh SessionManager instance and mock transport for each test.
   * This ensures test isolation - each test starts with a clean state.
   */
  beforeEach(() => {
    // Create a new SessionManager instance for each test
    // This ensures no session state leaks between tests
    sessionManager = new SessionManager();
    // Create a mock transport object
    // In real usage, this would be a StreamableHTTPServerTransport instance
    // We only need the sessionId property for these tests
    mockTransport = {
      sessionId: "test-session-1", // Unique session identifier
    } as unknown as StreamableHTTPServerTransport;
  });

  /**
   * Test suite for storeTransport method
   *
   * This method stores a transport instance in the session manager, associating
   * it with a session ID. It optionally stores a Notion token for multi-tenant support.
   */
  describe("storeTransport", () => {
    /**
     * Test: Transport should be stored and retrievable by session ID
     *
     * This is the basic functionality - storing a transport and being able
     * to retrieve it later. This is essential for routing requests to the
     * correct transport based on session ID.
     */
    it("should store transport with session ID", () => {
      // Arrange: No setup needed - using fresh sessionManager from beforeEach

      // Act: Store a transport with a session ID
      sessionManager.storeTransport("session-1", mockTransport);

      // Assert: Verify the transport can be retrieved
      // getTransport() should return the same transport instance we stored
      expect(sessionManager.getTransport("session-1")).toBe(mockTransport);
      // hasSession() should return true, indicating the session exists
      expect(sessionManager.hasSession("session-1")).toBe(true);
    });

    /**
     * Test: Notion token should be stored when provided
     *
     * This tests the multi-tenant feature - when a Notion token is provided
     * during transport storage, it should be associated with that session.
     * This allows each session to use a different Notion workspace.
     */
    it("should store Notion token when provided", () => {
      // Arrange: Define a Notion token to store
      const notionToken = "ntn_test_token_123";

      // Act: Store transport with a Notion token
      // The third parameter is the optional Notion token for multi-tenant support
      sessionManager.storeTransport("session-1", mockTransport, notionToken);

      // Assert: Verify the token was stored and can be retrieved
      // getToken() should return the token we provided
      expect(sessionManager.getToken("session-1")).toBe(notionToken);
    });

    /**
     * Test: Token should not be stored when not provided
     *
     * This tests that the token parameter is truly optional. When no token
     * is provided, the session should still be stored, but getToken() should
     * return undefined. This supports backward compatibility with single-tenant
     * scenarios where NOTION_TOKEN env var is used instead.
     */
    it("should not store token when not provided", () => {
      // Arrange: No setup needed

      // Act: Store transport WITHOUT providing a Notion token
      sessionManager.storeTransport("session-1", mockTransport);

      // Assert: Verify no token was stored
      // getToken() should return undefined when no token was provided
      expect(sessionManager.getToken("session-1")).toBeUndefined();
    });
  });

  /**
   * Test suite for getTransport method
   *
   * This method retrieves a transport instance by session ID. It's used by
   * the MCP handlers to route requests to the correct transport.
   */
  describe("getTransport", () => {
    /**
     * Test: Should return transport for existing session
     *
     * This is the happy path - when a session exists, getTransport() should
     * return the transport instance that was stored for that session.
     */
    it("should return transport for existing session", () => {
      // Arrange: Store a transport first
      sessionManager.storeTransport("session-1", mockTransport);

      // Act: Retrieve the transport by session ID
      const transport = sessionManager.getTransport("session-1");

      // Assert: Verify the correct transport was returned
      // The returned transport should be the same instance we stored
      expect(transport).toBe(mockTransport);
    });

    /**
     * Test: Should return undefined for non-existent session
     *
     * This tests error handling - when a session doesn't exist, getTransport()
     * should return undefined rather than throwing an error. This allows the
     * caller to handle the missing session gracefully.
     */
    it("should return undefined for non-existent session", () => {
      // Arrange: No setup - session doesn't exist

      // Act: Try to retrieve transport for a non-existent session
      const transport = sessionManager.getTransport("non-existent");

      // Assert: Verify undefined was returned
      // This indicates the session doesn't exist, allowing the caller to handle it
      expect(transport).toBeUndefined();
    });
  });

  /**
   * Test suite for updateToken method
   *
   * This method updates the Notion token for an existing session. This enables
   * the multi-tenant feature where a session can switch between Notion workspaces
   * mid-session by providing a new X-Notion-Token header.
   */
  describe("updateToken", () => {
    /**
     * Test: Should update token for existing session
     *
     * This tests the token update functionality - when a client provides a new
     * X-Notion-Token header for an existing session, the session's token should
     * be updated. This allows switching workspaces without creating a new session.
     */
    it("should update token for existing session", () => {
      // Arrange: Store a transport with an initial token
      sessionManager.storeTransport("session-1", mockTransport, "old-token");

      // Act: Update the token for this session
      sessionManager.updateToken("session-1", "new-token");

      // Assert: Verify the token was updated
      // getToken() should return the new token, not the old one
      expect(sessionManager.getToken("session-1")).toBe("new-token");
    });

    /**
     * Test: Should not update token for non-existent session
     *
     * This tests that updateToken() gracefully handles attempts to update
     * tokens for sessions that don't exist. It should not throw an error,
     * but also should not create a new session or store the token.
     */
    it("should not update token for non-existent session", () => {
      // Arrange: No setup - session doesn't exist

      // Act: Try to update token for a non-existent session
      sessionManager.updateToken("non-existent", "new-token");

      // Assert: Verify no token was stored
      // getToken() should return undefined because the session doesn't exist
      expect(sessionManager.getToken("non-existent")).toBeUndefined();
    });
  });

  /**
   * Test suite for getToken method
   *
   * This method retrieves the Notion token associated with a session. It's used
   * by the MCP proxy to get the correct Notion token for a given session when
   * making API calls. This enables multi-tenant support.
   */
  describe("getToken", () => {
    /**
     * Test: Should return token for session with token
     *
     * This is the happy path - when a session has an associated Notion token,
     * getToken() should return that token. This is used by the proxy to make
     * Notion API calls with the correct workspace token.
     */
    it("should return token for session with token", () => {
      // Arrange: Store a transport with a Notion token
      sessionManager.storeTransport("session-1", mockTransport, "test-token");

      // Act: Retrieve the token for this session
      const token = sessionManager.getToken("session-1");

      // Assert: Verify the correct token was returned
      // The returned token should match what we stored
      expect(token).toBe("test-token");
    });

    /**
     * Test: Should return undefined for session without token
     *
     * This tests backward compatibility - when a session was created without
     * a Notion token (using NOTION_TOKEN env var instead), getToken() should
     * return undefined. The proxy will then fall back to using the env var.
     */
    it("should return undefined for session without token", () => {
      // Arrange: Store a transport WITHOUT providing a Notion token
      sessionManager.storeTransport("session-1", mockTransport);

      // Act: Try to retrieve the token
      const token = sessionManager.getToken("session-1");

      // Assert: Verify undefined was returned
      // This indicates the session doesn't have a custom token and should
      // use the NOTION_TOKEN env var instead
      expect(token).toBeUndefined();
    });

    /**
     * Test: Should return undefined for non-existent session
     *
     * This tests error handling - when a session doesn't exist, getToken()
     * should return undefined rather than throwing an error. This allows the
     * caller to handle the missing session gracefully.
     */
    it("should return undefined for non-existent session", () => {
      // Arrange: No setup - session doesn't exist

      // Act: Try to retrieve token for a non-existent session
      const token = sessionManager.getToken("non-existent");

      // Assert: Verify undefined was returned
      // This indicates the session doesn't exist
      expect(token).toBeUndefined();
    });
  });

  /**
   * Test suite for removeSession method
   *
   * This method removes a session from the session manager, cleaning up both
   * the transport and the associated Notion token. This is called when a
   * session is closed to prevent memory leaks.
   */
  describe("removeSession", () => {
    /**
     * Test: Should remove session and its token
     *
     * This tests the cleanup functionality - when a session is removed, both
     * the transport and the token should be deleted. This prevents memory
     * leaks and ensures closed sessions don't consume resources.
     */
    it("should remove session and its token", () => {
      // Arrange: Store a transport with a token
      sessionManager.storeTransport("session-1", mockTransport, "test-token");

      // Act: Remove the session
      sessionManager.removeSession("session-1");

      // Assert: Verify both transport and token were removed
      // hasSession() should return false, indicating the session no longer exists
      expect(sessionManager.hasSession("session-1")).toBe(false);
      // getToken() should return undefined, indicating the token was also removed
      expect(sessionManager.getToken("session-1")).toBeUndefined();
    });

    /**
     * Test: Should handle removing non-existent session gracefully
     *
     * This tests error handling - when trying to remove a session that doesn't
     * exist, removeSession() should not throw an error. This makes it safe to
     * call during cleanup operations without checking if the session exists first.
     */
    it("should handle removing non-existent session gracefully", () => {
      // Arrange: No setup - session doesn't exist

      // Act & Assert: Verify removing a non-existent session doesn't throw
      // This is important for cleanup code that might be called multiple times
      // or when a session was already removed
      expect(() => {
        sessionManager.removeSession("non-existent");
      }).not.toThrow();
    });
  });

  /**
   * Test suite for getActiveSessions method
   *
   * This method returns an array of all active session IDs. This is useful for
   * debugging, monitoring, and logging purposes. It allows the server to know
   * how many concurrent sessions are active.
   */
  describe("getActiveSessions", () => {
    /**
     * Test: Should return empty array when no sessions
     *
     * This tests the initial state - when no sessions have been created,
     * getActiveSessions() should return an empty array. This is the expected
     * state when the server first starts.
     */
    it("should return empty array when no sessions", () => {
      // Arrange: No setup - no sessions have been stored

      // Act: Get the list of active sessions
      const sessions = sessionManager.getActiveSessions();

      // Assert: Verify empty array was returned
      // This indicates no sessions are currently active
      expect(sessions).toEqual([]);
    });

    /**
     * Test: Should return all active session IDs
     *
     * This tests that getActiveSessions() correctly returns all session IDs
     * that have been stored. This is useful for debugging and monitoring
     * how many concurrent sessions are active.
     */
    it("should return all active session IDs", () => {
      // Arrange: Create multiple transports and store them
      const transport1 = {
        sessionId: "session-1",
      } as unknown as StreamableHTTPServerTransport;
      const transport2 = {
        sessionId: "session-2",
      } as unknown as StreamableHTTPServerTransport;

      // Store multiple sessions
      sessionManager.storeTransport("session-1", transport1);
      sessionManager.storeTransport("session-2", transport2);

      // Act: Get the list of active sessions
      const sessions = sessionManager.getActiveSessions();

      // Assert: Verify all session IDs are included
      // The array should contain both session IDs we stored
      expect(sessions).toContain("session-1");
      expect(sessions).toContain("session-2");
      // The array should have exactly 2 elements (no duplicates, no extras)
      expect(sessions.length).toBe(2);
    });
  });

  /**
   * Test suite for hasSession method
   *
   * This method checks if a session exists in the session manager. It's a
   * convenience method for checking session existence without retrieving
   * the transport. Used by handlers to validate session IDs.
   */
  describe("hasSession", () => {
    /**
     * Test: Should return true for existing session
     *
     * This is the happy path - when a session exists, hasSession() should
     * return true. This is used by handlers to quickly check if a session
     * ID is valid before processing a request.
     */
    it("should return true for existing session", () => {
      // Arrange: Store a transport to create a session
      sessionManager.storeTransport("session-1", mockTransport);

      // Act: Check if the session exists
      // (No explicit act needed - the expect is the act)

      // Assert: Verify hasSession() returns true
      // This indicates the session exists and can be used
      expect(sessionManager.hasSession("session-1")).toBe(true);
    });

    /**
     * Test: Should return false for non-existent session
     *
     * This tests error handling - when a session doesn't exist, hasSession()
     * should return false. This allows handlers to quickly validate session
     * IDs and reject invalid requests.
     */
    it("should return false for non-existent session", () => {
      // Arrange: No setup - session doesn't exist

      // Act & Assert: Verify hasSession() returns false
      // This indicates the session doesn't exist and requests with this
      // session ID should be rejected
      expect(sessionManager.hasSession("non-existent")).toBe(false);
    });
  });

  /**
   * Test suite for getTokenLookup method
   *
   * This method returns a function that can be passed to the MCP proxy to
   * retrieve Notion tokens by session ID. The proxy uses this function to
   * get the correct Notion token when making API calls. This enables the
   * multi-tenant feature where each session can use a different token.
   */
  describe("getTokenLookup", () => {
    /**
     * Test: Should return function that retrieves tokens
     *
     * This tests that getTokenLookup() returns a function that correctly
     * retrieves tokens for different sessions. The returned function is
     * passed to the MCP proxy, which calls it with a session ID to get
     * the Notion token for that session.
     */
    it("should return function that retrieves tokens", () => {
      // Arrange: Store multiple sessions with different tokens
      // This simulates a multi-tenant scenario where different sessions
      // use different Notion workspaces
      sessionManager.storeTransport("session-1", mockTransport, "token-1");
      sessionManager.storeTransport("session-2", mockTransport, "token-2");

      // Act: Get the token lookup function
      const lookup = sessionManager.getTokenLookup();

      // Assert: Verify the lookup function works correctly
      // It should return the correct token for each session
      expect(lookup("session-1")).toBe("token-1");
      expect(lookup("session-2")).toBe("token-2");
      // It should return undefined for non-existent sessions
      expect(lookup("non-existent")).toBeUndefined();
    });
  });

  /**
   * Test suite for multiple sessions
   *
   * This tests that the SessionManager correctly handles multiple concurrent
   * sessions. Each session should be independent - storing, retrieving, and
   * removing one session should not affect other sessions. This is critical
   * for multi-tenant support where multiple users/workspaces are active simultaneously.
   */
  describe("multiple sessions", () => {
    /**
     * Test: Should handle multiple sessions independently
     *
     * This is an integration-style test that verifies all the SessionManager
     * methods work correctly when multiple sessions are active. It tests:
     * - Storing multiple sessions with different tokens
     * - Retrieving transports and tokens for each session
     * - Removing one session without affecting others
     *
     * This ensures session isolation - sessions don't interfere with each other.
     */
    it("should handle multiple sessions independently", () => {
      // Arrange: Create multiple transports for different sessions
      const transport1 = {
        sessionId: "session-1",
      } as unknown as StreamableHTTPServerTransport;
      const transport2 = {
        sessionId: "session-2",
      } as unknown as StreamableHTTPServerTransport;

      // Store multiple sessions with different tokens
      // This simulates a multi-tenant scenario where different sessions
      // represent different users or workspaces
      sessionManager.storeTransport("session-1", transport1, "token-1");
      sessionManager.storeTransport("session-2", transport2, "token-2");

      // Assert: Verify both sessions are stored correctly
      // Each session should have its own transport
      expect(sessionManager.getTransport("session-1")).toBe(transport1);
      expect(sessionManager.getTransport("session-2")).toBe(transport2);
      // Each session should have its own token
      expect(sessionManager.getToken("session-1")).toBe("token-1");
      expect(sessionManager.getToken("session-2")).toBe("token-2");

      // Act: Remove one session
      sessionManager.removeSession("session-1");

      // Assert: Verify session isolation
      // session-1 should be removed (no longer exists)
      expect(sessionManager.hasSession("session-1")).toBe(false);
      // session-2 should still exist (removing session-1 didn't affect it)
      expect(sessionManager.hasSession("session-2")).toBe(true);
    });
  });
});
