/**
 * Authentication middleware for Notion MCP Server
 *
 * This module provides bearer token authentication for HTTP endpoints.
 * It validates the "Authorization: Bearer <token>" header against the server's token.
 *
 * The middleware:
 * - Extracts the bearer token from the Authorization header
 * - Validates it against the server's configured token
 * - Returns appropriate error responses for authentication failures
 * - Allows requests to proceed if authentication succeeds
 *
 * Security features:
 * - Logs authentication failures for security monitoring
 * - Uses JSON-RPC error format for consistency with MCP protocol
 * - Returns different status codes for different failure types (401 vs 403)
 */

import express from "express";
import { logger } from "../utils/logger";

/**
 * Create authentication middleware function
 *
 * This is a factory function that creates an Express middleware function for
 * bearer token authentication. The middleware validates that incoming requests
 * include a valid bearer token in the Authorization header.
 *
 * How it works:
 * 1. Extracts the Authorization header from the request
 * 2. Parses the bearer token from "Bearer <token>" format
 * 3. Compares the token against the server's configured token
 * 4. Rejects with 401/403 if invalid, allows if valid
 *
 * @param authToken - The bearer token that clients must provide to authenticate
 *                    This should match the token configured on the server
 * @returns Express middleware function that validates bearer token authentication
 *          The middleware calls next() if authentication succeeds, or sends an
 *          error response and stops processing if authentication fails
 */
export function createAuthMiddleware(authToken: string) {
  /**
   * Return the Express middleware function
   *
   * This function will be called by Express for each request that uses this
   * middleware. It follows the Express middleware pattern:
   * - Receives req, res, and next
   * - Validates the request
   * - Calls next() to continue, or sends response and stops
   */
  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    /**
     * Extract the Authorization header from the request
     *
     * The Authorization header should be in the format: "Bearer <token>"
     * This is the standard HTTP bearer token authentication format.
     *
     * If the header is not present, authHeader will be undefined.
     * If the header is present but malformed, we'll handle it in the parsing step.
     */
    const authHeader = req.headers["authorization"];

    /**
     * Split the header to extract just the token part
     *
     * The Authorization header format is: "Bearer <token>"
     * We split on space to separate "Bearer" from the actual token.
     *
     * Examples:
     * - "Bearer mytoken123" -> split(" ") -> ["Bearer", "mytoken123"] -> [1] = "mytoken123"
     * - "Bearer" -> split(" ") -> ["Bearer"] -> [1] = undefined (missing token)
     * - undefined -> undefined && ... -> undefined (no header)
     *
     * The && operator ensures we only call split() if authHeader exists.
     * If authHeader is undefined, token will be undefined.
     */
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    /**
     * Case 1: No token provided in the request
     *
     * This handles the case where:
     * - No Authorization header was provided
     * - Authorization header was provided but doesn't contain "Bearer " prefix
     * - Authorization header was provided but token part is missing (e.g., "Bearer ")
     *
     * In all these cases, token will be undefined, and we reject the request
     * with a 401 Unauthorized error. This indicates the client needs to provide
     * credentials but hasn't done so.
     */
    if (!token) {
      /**
       * Log the authentication failure for security monitoring
       *
       * We log authentication failures to help with:
       * - Security monitoring (detect brute force attacks, unauthorized access attempts)
       * - Debugging (understand why requests are being rejected)
       * - Auditing (track who tried to access what endpoints)
       *
       * We include:
       * - component: "auth" (identifies this as authentication-related logging)
       * - ip: Client IP address (for tracking and blocking malicious IPs)
       * - path: The endpoint that was accessed (to see what resources are being targeted)
       */
      logger.warning("Authentication failed: Missing bearer token", {
        component: "auth", // Identifies this as authentication-related logging
        ip: req.ip, // Log client IP for security tracking
        path: req.path, // Log which endpoint was accessed
      });

      /**
       * Return 401 Unauthorized with JSON-RPC error format
       *
       * We use 401 Unauthorized because:
       * - The client hasn't provided credentials (needs to authenticate)
       * - This is different from 403 Forbidden (credentials provided but invalid)
       *
       * We use JSON-RPC error format because:
       * - The MCP protocol is based on JSON-RPC
       * - This maintains consistency with other MCP error responses
       * - Clients expect JSON-RPC formatted errors
       *
       * Error code -32001 is a custom error code for missing authentication token.
       * JSON-RPC reserves -32000 to -32099 for implementation-defined server errors.
       */
      res.status(401).json({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32001, // Custom error code for missing auth token
          message: "Unauthorized: Missing bearer token", // Human-readable error message
        },
        id: null, // No request ID since this is a middleware-level error (before JSON-RPC parsing)
      });
      return; // Stop request processing - don't call next(), don't continue to route handler
    }

    /**
     * Case 2: Token provided but doesn't match server's token
     *
     * This handles the case where:
     * - Authorization header was provided with a token
     * - The token was successfully extracted
     * - But the token doesn't match the server's configured token
     *
     * This is different from Case 1 (no token) - here the client tried to
     * authenticate but provided incorrect credentials. We use 403 Forbidden
     * instead of 401 Unauthorized to indicate the difference.
     */
    if (token !== authToken) {
      /**
       * Log the authentication failure
       *
       * We log invalid token attempts for the same reasons as missing tokens:
       * - Security monitoring (detect brute force attacks)
       * - Debugging (understand authentication issues)
       * - Auditing (track failed authentication attempts)
       *
       * Note: We don't log the actual token values for security reasons
       * (tokens are sensitive and shouldn't appear in logs).
       */
      logger.warning("Authentication failed: Invalid bearer token", {
        component: "auth", // Identifies this as authentication-related logging
        ip: req.ip, // Log client IP for security tracking
        path: req.path, // Log which endpoint was accessed
      });

      /**
       * Return 403 Forbidden with JSON-RPC error format
       *
       * We use 403 Forbidden because:
       * - The client provided credentials (unlike 401 where none were provided)
       * - The credentials are invalid (wrong token)
       * - The client is "forbidden" from accessing the resource with these credentials
       *
       * We use JSON-RPC error format for consistency with MCP protocol responses.
       *
       * Error code -32002 is a custom error code for invalid authentication token.
       * This is different from -32001 (missing token) to help clients distinguish
       * between "no credentials" and "wrong credentials".
       */
      res.status(403).json({
        jsonrpc: "2.0", // JSON-RPC version
        error: {
          code: -32002, // Custom error code for invalid auth token
          message: "Forbidden: Invalid bearer token", // Human-readable error message
        },
        id: null, // No request ID since this is a middleware-level error
      });
      return; // Stop request processing - don't call next(), don't continue to route handler
    }

    /**
     * Case 3: Authentication successful
     *
     * If we reach this point, it means:
     * - A token was provided in the Authorization header
     * - The token was successfully extracted
     * - The token matches the server's configured token
     *
     * At this point, authentication is complete and successful. We log the
     * success (for debugging) and then call next() to allow the request to
     * continue to the next middleware or route handler.
     */
    /**
     * Log authentication success (only if DEBUG_MODE enabled)
     *
     * We only log successful authentications at DEBUG level because:
     * - Successful authentications are the normal case (would spam logs)
     * - We only need this for debugging authentication issues
     * - Failed authentications are logged at WARNING level (more important)
     *
     * If DEBUG_MODE is not enabled, this log won't appear, keeping logs clean
     * while still allowing detailed debugging when needed.
     */
    logger.debug("Authentication successful", {
      component: "auth", // Identifies this as authentication-related logging
      ip: req.ip, // Log client IP (for debugging connection issues)
      path: req.path, // Log which endpoint was accessed (for debugging routing)
    });

    /**
     * Call next() to continue to the next middleware/route handler
     *
     * This is the Express middleware pattern - calling next() passes control
     * to the next middleware in the chain, or to the route handler if this
     * is the last middleware.
     *
     * By calling next(), we're saying "authentication passed, continue processing
     * this request". The request will now proceed to the actual route handler
     * (e.g., the MCP handlers).
     *
     * If we don't call next(), the request processing stops here (which is what
     * we do in the error cases above).
     */
    next();
  };
}
