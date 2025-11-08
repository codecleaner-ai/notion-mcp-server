import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { parseArgs, type ServerOptions } from "../args-parser";

/**
 * Test suite for command-line argument parser
 *
 * This suite tests the parseArgs() function which extracts configuration from
 * command-line arguments. The parser handles:
 * - Transport type selection (stdio or http)
 * - Port number specification
 * - Authentication token configuration
 * - Help flag display
 * - Argument validation and normalization
 *
 * The parser is critical for server startup configuration and must handle
 * various edge cases gracefully.
 */
describe("args-parser", () => {
  // Store original process.argv to restore after tests
  // This prevents tests from affecting each other or the actual process
  const originalArgv = process.argv;
  // Store original process.exit to restore after tests
  // This prevents tests from actually exiting the process
  const originalExit = process.exit;

  /**
   * Setup before each test
   *
   * Resets process.argv and mocks process.exit to ensure test isolation.
   * This prevents tests from interfering with each other or causing the
   * test process to exit unexpectedly.
   */
  beforeEach(() => {
    // Reset process.argv to original value before each test
    // This ensures each test starts with a clean argument list
    process.argv = originalArgv;
    // Mock process.exit to prevent actual process exit during tests
    // When parseArgs() encounters --help, it calls process.exit(0)
    // We mock this so tests can verify the exit was called without actually exiting
    process.exit = vi.fn() as unknown as typeof process.exit;
  });

  /**
   * Cleanup after each test
   *
   * Restores original process.argv and process.exit, and clears all mocks.
   * This ensures the test environment is clean for the next test.
   */
  afterEach(() => {
    // Restore original process.argv
    process.argv = originalArgv;
    // Restore original process.exit
    process.exit = originalExit;
    // Clear all mocks to prevent test interference
    vi.clearAllMocks();
  });

  /**
   * Test suite for parseArgs function
   *
   * Tests various scenarios for parsing command-line arguments:
   * - Default values when no arguments provided
   * - Individual argument parsing (transport, port, auth-token)
   * - Multiple arguments together
   * - Help flag handling
   * - Edge cases (missing values, unrecognized args, etc.)
   */
  describe("parseArgs", () => {
    /**
     * Test: Should return default values when no arguments provided
     *
     * This tests the baseline behavior - when a user runs the server without
     * any command-line arguments, the parser should return sensible defaults.
     * This ensures the server can start without explicit configuration.
     */
    it("should return default values when no arguments provided", () => {
      // Arrange: Simulate running the script with no user-provided arguments
      // process.argv format: [node_executable, script_path, ...user_args]
      // Here we only have the first two elements (no user args)
      process.argv = ["node", "script.js"];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify default values are returned
      // These defaults allow the server to start in stdio mode (for desktop apps)
      // on the default port, without requiring explicit configuration
      expect(result).toEqual({
        transport: "stdio", // Default to stdio for compatibility with desktop apps
        port: 3000, // Default HTTP port (not used in stdio mode)
        authToken: undefined, // No default token (will be auto-generated if needed)
      });
    });

    /**
     * Test: Should parse --transport argument
     *
     * This tests that the parser correctly extracts the transport type from
     * the command-line arguments. The transport determines how the server
     * communicates (stdio for desktop apps, http for web/backend services).
     */
    it("should parse --transport argument", () => {
      // Arrange: Simulate running with --transport http argument
      process.argv = ["node", "script.js", "--transport", "http"];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify transport was parsed correctly
      // The result should contain "http" as the transport type
      expect(result.transport).toBe("http");
    });

    /**
     * Test: Should normalize transport to lowercase
     *
     * This tests that the parser is case-insensitive for transport values.
     * Users might type "HTTP" or "Http" or "http" - all should work the same.
     * This improves user experience by being forgiving of case variations.
     */
    it("should normalize transport to lowercase", () => {
      // Arrange: Simulate running with --transport HTTP (uppercase)
      process.argv = ["node", "script.js", "--transport", "HTTP"];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify transport was normalized to lowercase
      // This ensures case-insensitive matching works correctly
      expect(result.transport).toBe("http");
    });

    /**
     * Test: Should parse --port argument
     *
     * This tests that the parser correctly extracts the port number from
     * command-line arguments. The port is used when running in HTTP mode
     * to specify which port the server should listen on.
     */
    it("should parse --port argument", () => {
      // Arrange: Simulate running with --port 8080 argument
      process.argv = ["node", "script.js", "--port", "8080"];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify port was parsed correctly as an integer
      // The port should be parsed as a number, not a string
      expect(result.port).toBe(8080);
    });

    /**
     * Test: Should parse --auth-token argument
     *
     * This tests that the parser correctly extracts the authentication token
     * from command-line arguments. The auth token is used to secure HTTP
     * endpoints and prevent unauthorized access.
     */
    it("should parse --auth-token argument", () => {
      // Arrange: Simulate running with --auth-token argument
      process.argv = ["node", "script.js", "--auth-token", "test-token-123"];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify auth token was parsed correctly
      // The token should be stored as-is (no transformation)
      expect(result.authToken).toBe("test-token-123");
    });

    /**
     * Test: Should parse multiple arguments together
     *
     * This tests that the parser correctly handles multiple arguments in a
     * single command. Users often provide multiple configuration options
     * together (e.g., transport, port, and auth token all at once).
     * The parser must correctly extract all of them.
     */
    it("should parse multiple arguments together", () => {
      // Arrange: Simulate running with multiple arguments
      // This is a common real-world scenario where users provide all config at once
      process.argv = [
        "node",
        "script.js",
        "--transport",
        "http",
        "--port",
        "3002",
        "--auth-token",
        "my-token",
      ];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify all arguments were parsed correctly
      // The result should contain all three values we provided
      expect(result).toEqual({
        transport: "http", // Transport type
        port: 3002, // Port number (parsed as integer)
        authToken: "my-token", // Authentication token
      });
    });

    /**
     * Test: Should handle --help flag and exit
     *
     * This tests that when users provide the --help flag, the parser:
     * 1. Displays help information to the console
     * 2. Exits the process with code 0 (success)
     *
     * This is standard Unix behavior - help flags should display usage
     * information and exit immediately, not start the server.
     */
    it("should handle --help flag and exit", () => {
      // Arrange: Mock console.log to capture help message output
      // We don't want help text cluttering test output, so we mock it
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      // Simulate running with --help flag
      process.argv = ["node", "script.js", "--help"];

      // Act: Parse the arguments
      // This should trigger help display and process.exit(0)
      parseArgs();

      // Assert: Verify help was displayed and process exited
      // console.log should have been called to display help text
      expect(consoleSpy).toHaveBeenCalled();
      // process.exit should have been called with code 0 (success)
      // This indicates the help was displayed and the process should exit
      expect(process.exit).toHaveBeenCalledWith(0);
      // Clean up: Restore original console.log
      consoleSpy.mockRestore();
    });

    /**
     * Test: Should handle -h flag and exit
     *
     * This tests the short form of the help flag. Many Unix tools support
     * both --help (long form) and -h (short form). The parser should handle
     * both identically.
     */
    it("should handle -h flag and exit", () => {
      // Arrange: Mock console.log to capture help message output
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      // Simulate running with -h flag (short form of --help)
      process.argv = ["node", "script.js", "-h"];

      // Act: Parse the arguments
      parseArgs();

      // Assert: Verify help was displayed and process exited
      // Both --help and -h should behave identically
      expect(consoleSpy).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
      // Clean up: Restore original console.log
      consoleSpy.mockRestore();
    });

    /**
     * Test: Should ignore unrecognized arguments
     *
     * This tests that the parser gracefully handles unrecognized arguments
     * without throwing errors. This is important because:
     * - Docker or other wrappers might pass additional arguments
     * - Users might make typos
     * - Future versions might add new arguments
     *
     * The parser should extract what it recognizes and ignore the rest.
     */
    it("should ignore unrecognized arguments", () => {
      // Arrange: Simulate running with both recognized and unrecognized arguments
      // This tests that the parser doesn't break when encountering unknown args
      process.argv = [
        "node",
        "script.js",
        "--transport",
        "http", // Recognized argument
        "--unknown-arg",
        "value", // Unrecognized argument (should be ignored)
      ];

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify recognized arguments were parsed, unrecognized ones ignored
      // The transport should be parsed correctly
      expect(result.transport).toBe("http");
      // The port should use default value (unrecognized args don't affect defaults)
      expect(result.port).toBe(3000); // Default value
    });

    /**
     * Test: Should handle missing argument values gracefully
     *
     * This tests error handling when a user provides an argument flag but
     * forgets to provide the value. For example: "--transport" without "http".
     * The parser should not crash, but should use default values instead.
     */
    it("should handle missing argument values gracefully", () => {
      // Arrange: Simulate running with --transport flag but no value
      // This could happen if a user types "--transport" and forgets the value
      process.argv = ["node", "script.js", "--transport"]; // Missing value after --transport

      // Act: Parse the arguments
      const result = parseArgs();

      // Assert: Verify default value was used
      // When the value is missing, the parser should fall back to defaults
      // This prevents crashes and provides a reasonable fallback
      expect(result.transport).toBe("stdio"); // Should use default when value is missing
    });

    /**
     * Test: Should accept custom args array
     *
     * This tests that parseArgs() can accept a custom arguments array instead
     * of using process.argv. This is useful for:
     * - Testing with different argument combinations
     * - Programmatic usage (calling from code, not command line)
     * - Integration with other tools that pass arguments programmatically
     */
    it("should accept custom args array", () => {
      // Arrange: Create a custom arguments array
      // This simulates programmatic usage where args are passed directly
      const customArgs = [
        "node",
        "script.js",
        "--transport",
        "http",
        "--port",
        "9999",
      ];

      // Act: Parse the custom arguments array
      const result = parseArgs(customArgs);

      // Assert: Verify the custom arguments were parsed correctly
      // This proves the function works with both process.argv and custom arrays
      expect(result).toEqual({
        transport: "http", // Parsed from custom args
        port: 9999, // Parsed from custom args
        authToken: undefined, // Not provided in custom args
      });
    });
  });
});
