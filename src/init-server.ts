/**
 * Notion MCP Server Initialization Module
 *
 * This module handles the initialization of the MCP proxy by:
 * 1. Loading the Notion OpenAPI specification from JSON file
 * 2. Parsing and validating the OpenAPI specification
 * 3. Creating and initializing the MCPProxy instance
 *
 * The MCPProxy acts as a bridge between the MCP protocol and the Notion API,
 * translating MCP tool calls into Notion API requests.
 */

// Node.js file system module for reading files
import fs from "node:fs";
// Node.js path module for resolving file paths
import path from "node:path";

// TypeScript types for OpenAPI 3.0 specification
import { OpenAPIV3 } from "openapi-types";
// OpenAPI schema validator (imported but not currently used - may be used for validation in future)
import OpenAPISchemaValidator from "openapi-schema-validator";

// MCPProxy class - the core component that bridges MCP protocol and Notion API
import { MCPProxy } from "./openapi-mcp-server/mcp/proxy";
// Custom logger utility for structured logging
import { logger } from "./utils/logger";

/**
 * Custom Error Class for OpenAPI Validation Failures
 *
 * This error is thrown when the OpenAPI specification file is invalid or malformed.
 * It extends the standard Error class and includes an array of validation errors
 * to provide detailed feedback about what went wrong.
 *
 * Usage:
 * - Thrown when OpenAPI spec validation fails
 * - Caught in start-server.ts to provide user-friendly error messages
 */
export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super("OpenAPI validation failed");
    this.name = "ValidationError";
  }
}

/**
 * Load and Parse OpenAPI Specification
 *
 * This function reads the Notion OpenAPI specification JSON file from disk,
 * parses it, and optionally overrides the base URL.
 *
 * The OpenAPI specification defines:
 * - All available Notion API endpoints
 * - Request/response schemas for each endpoint
 * - Authentication requirements
 * - Parameter validation rules
 *
 * This specification is used by the MCPProxy to:
 * - Generate MCP tools from Notion API endpoints
 * - Validate request parameters
 * - Transform responses to MCP format
 *
 * @param specPath - Relative or absolute path to the OpenAPI JSON file
 * @param baseUrl - Optional override for the Notion API base URL (default: https://api.notion.com)
 * @returns Promise resolving to the parsed OpenAPI document
 * @throws ValidationError if the specification is invalid
 */
async function loadOpenApiSpec(
  specPath: string,
  baseUrl: string | undefined,
): Promise<OpenAPIV3.Document> {
  let rawSpec: string;

  // ============================================================================
  // STEP 1: READ THE OPENAPI SPECIFICATION FILE
  // ============================================================================
  // We read the file synchronously because:
  // 1. This is a startup operation (only happens once)
  // 2. We need the spec before we can start the server
  // 3. Async file reading would complicate error handling
  try {
    // Resolve the spec path relative to the current working directory
    // process.cwd() returns the directory where the Node.js process was started
    // This allows the spec path to be relative to the project root
    const resolvedPath = path.resolve(process.cwd(), specPath);

    // Read the file as UTF-8 text (JSON is text-based)
    rawSpec = fs.readFileSync(resolvedPath, "utf-8");

    // Log successful file read (only if DEBUG_MODE enabled)
    logger.debug("OpenAPI specification file loaded", {
      component: "init",
      specPath: resolvedPath, // Log the resolved path for debugging
    });
  } catch (error) {
    // File read failed - this is a critical error
    // Possible causes:
    // - File doesn't exist at the specified path
    // - Insufficient file permissions
    // - Disk I/O error
    logger.critical(
      "Failed to read OpenAPI specification file",
      {
        component: "init",
        specPath, // Log the original path for debugging
      },
      error as Error,
    );

    // Also log to console for immediate visibility
    // Users need to see this error immediately to fix the issue
    console.error(
      "Failed to read OpenAPI specification file:",
      (error as Error).message,
    );

    // Exit with error code 1 (failure)
    // Server cannot start without a valid OpenAPI specification
    process.exit(1);
  }

  // ============================================================================
  // STEP 2: PARSE AND VALIDATE THE OPENAPI SPECIFICATION
  // ============================================================================
  // Parse the JSON string into a JavaScript object and validate it
  try {
    // Parse the JSON string into a JavaScript object
    // JSON.parse will throw if the JSON is malformed
    const parsed = JSON.parse(rawSpec);

    // ============================================================================
    // STEP 3: OVERRIDE BASE URL (IF SPECIFIED)
    // ============================================================================
    // The OpenAPI spec includes a default base URL (https://api.notion.com)
    // We allow overriding this via the BASE_URL environment variable for:
    // - Testing with mock Notion API servers
    // - Using proxy servers
    // - Development/staging environments
    if (baseUrl) {
      // OpenAPI 3.0 specs have a "servers" array with at least one server
      // We override the first server's URL
      parsed.servers[0].url = baseUrl;
    }

    // Log successful parsing (only if DEBUG_MODE enabled)
    logger.debug("OpenAPI specification parsed successfully", {
      component: "init",
      baseUrl: baseUrl || "default", // Log whether base URL was overridden
    });

    // Return the parsed OpenAPI document
    // Type assertion to OpenAPIV3.Document tells TypeScript this is a valid OpenAPI spec
    return parsed as OpenAPIV3.Document;
  } catch (error) {
    // JSON parsing failed - this is a critical error
    // Possible causes:
    // - Invalid JSON syntax (missing commas, quotes, etc.)
    // - File is corrupted
    // - File contains non-JSON content

    // Check if this is a ValidationError (from future validation logic)
    // If so, re-throw it so the caller can handle it appropriately
    if (error instanceof ValidationError) {
      throw error;
    }

    // Log the parsing failure
    logger.critical(
      "Failed to parse OpenAPI spec",
      {
        component: "init",
      },
      error as Error,
    );

    // Also log to console for immediate visibility
    console.error("Failed to parse OpenAPI spec:", (error as Error).message);

    // Exit with error code 1 (failure)
    // Server cannot start with an invalid OpenAPI specification
    process.exit(1);
  }
}

/**
 * Initialize MCP Proxy
 *
 * This is the main initialization function that creates and returns an MCPProxy instance.
 * The MCPProxy is the core component that:
 * - Converts Notion API endpoints into MCP tools
 * - Handles MCP protocol requests
 * - Translates MCP tool calls into Notion API requests
 * - Transforms Notion API responses back into MCP format
 *
 * Workflow:
 * 1. Load and parse the OpenAPI specification file
 * 2. Create a new MCPProxy instance with the parsed specification
 * 3. Return the proxy instance for connection to a transport
 *
 * @param specPath - Path to the OpenAPI specification JSON file
 * @param baseUrl - Optional override for Notion API base URL
 * @returns Promise resolving to an initialized MCPProxy instance
 *
 * @throws ValidationError if OpenAPI spec is invalid
 * @throws Error if file cannot be read or parsed
 *
 * Usage:
 * ```typescript
 * const proxy = await initProxy("./scripts/notion-openapi.json", undefined);
 * await proxy.connect(transport);
 * ```
 */
export async function initProxy(specPath: string, baseUrl: string | undefined) {
  // ============================================================================
  // STEP 1: LOG INITIALIZATION START
  // ============================================================================
  // Log that we're starting the proxy initialization process
  // This helps with debugging and monitoring startup time
  logger.debug("Initializing MCP proxy", {
    component: "init",
    specPath, // Log the spec path for debugging
    baseUrl: baseUrl || "default", // Log whether base URL override is used
  });

  // ============================================================================
  // STEP 2: LOAD AND PARSE OPENAPI SPECIFICATION
  // ============================================================================
  // Load the OpenAPI specification from the JSON file
  // This function handles file reading, JSON parsing, and base URL override
  // It will throw an error or exit if the spec is invalid
  const openApiSpec = await loadOpenApiSpec(specPath, baseUrl);

  // ============================================================================
  // STEP 3: CREATE MCP PROXY INSTANCE
  // ============================================================================
  // Create a new MCPProxy instance
  // The MCPProxy constructor:
  // - Analyzes the OpenAPI spec to extract all API endpoints
  // - Converts each endpoint into an MCP tool
  // - Sets up request/response handling
  // - Configures authentication headers (from NOTION_TOKEN env var)
  //
  // Parameters:
  // - "Notion API": Display name for the proxy (used in MCP protocol)
  // - openApiSpec: The parsed OpenAPI specification document
  const proxy = new MCPProxy("Notion API", openApiSpec);

  // ============================================================================
  // STEP 4: LOG SUCCESSFUL INITIALIZATION
  // ============================================================================
  // Log that the proxy was initialized successfully
  // This confirms that all tools were registered and the proxy is ready
  logger.debug("MCP proxy initialized successfully", {
    component: "init",
  });

  // ============================================================================
  // STEP 5: RETURN PROXY INSTANCE
  // ============================================================================
  // Return the initialized proxy instance
  // The caller (start-server.ts) will connect this proxy to a transport
  // (either STDIO or HTTP) to start accepting MCP requests
  return proxy;
}
