/**
 * Authentication middleware for Notion MCP Server
 *
 * This module provides API key authentication for HTTP endpoints.
 * It validates the "X-API-Key" header against the server's token.
 *
 * IMPORTANT: This middleware uses X-API-Key instead of Authorization: Bearer
 * to allow GCP IAM authentication (which requires Authorization: Bearer) to
 * coexist with application-level authentication.
 *
 * The middleware:
 * - Extracts the API key from the X-API-Key header
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
 * API key authentication. The middleware validates that incoming requests
 * include a valid API key in the X-API-Key header.
 *
 * How it works:
 * 1. Extracts the X-API-Key header from the request
 * 2. Compares the API key against the server's configured token
 * 3. Rejects with 401/403 if invalid, allows if valid
 *
 * @param authToken - The API key that clients must provide to authenticate
 *                    This should match the token configured on the server
 * @returns Express middleware function that validates API key authentication
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
     * Extract the X-API-Key header from the request
     *
     * The X-API-Key header contains the API key directly (no "Bearer" prefix needed).
     * This allows the Authorization header to be used for GCP IAM authentication
     * while X-API-Key is used for application-level authentication.
     *
     * If the header is not present, apiKey will be undefined.
     */
    const apiKey = req.headers["x-api-key"] as string | undefined;

    /**
     * Case 1: No API key provided in the request
     *
     * This handles the case where:
     * - No X-API-Key header was provided
     *
     * In this case, apiKey will be undefined, and we reject the request
     * with a 401 Unauthorized error. This indicates the client needs to provide
     * credentials but hasn't done so.
     */
    if (!apiKey) {
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
      logger.warning("Authentication failed: Missing API key", {
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
          message: "Unauthorized: Missing API key", // Human-readable error message
        },
        id: null, // No request ID since this is a middleware-level error (before JSON-RPC parsing)
      });
      return; // Stop request processing - don't call next(), don't continue to route handler
    }

    /**
     * Case 2: API key provided but doesn't match server's token
     *
     * This handles the case where:
     * - X-API-Key header was provided with a key
     * - But the key doesn't match the server's configured token
     *
     * This is different from Case 1 (no key) - here the client tried to
     * authenticate but provided incorrect credentials. We use 403 Forbidden
     * instead of 401 Unauthorized to indicate the difference.
     */
    if (apiKey !== authToken) {
      /**
       * Log the authentication failure
       *
       * We log invalid key attempts for the same reasons as missing keys:
       * - Security monitoring (detect brute force attacks)
       * - Debugging (understand authentication issues)
       * - Auditing (track failed authentication attempts)
       *
       * Note: We don't log the actual key values for security reasons
       * (keys are sensitive and shouldn't appear in logs).
       */
      logger.warning("Authentication failed: Invalid API key", {
        component: "auth", // Identifies this as authentication-related logging
        ip: req.ip, // Log client IP for security tracking
        path: req.path, // Log which endpoint was accessed
      });

      /**
       * Return 403 Forbidden with JSON-RPC error format
       *
       * We use 403 Forbidden because:
       * - The client provided credentials (unlike 401 where none were provided)
       * - The credentials are invalid (wrong key)
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
          message: "Forbidden: Invalid API key", // Human-readable error message
        },
        id: null, // No request ID since this is a middleware-level error
      });
      return; // Stop request processing - don't call next(), don't continue to route handler
    }

    /**
     * Case 3: Authentication successful
     *
     * If we reach this point, it means:
     * - An API key was provided in the X-API-Key header
     * - The API key matches the server's configured token
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
