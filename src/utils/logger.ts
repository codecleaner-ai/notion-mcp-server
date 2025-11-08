/**
 * Logger Utility for Notion MCP Server
 *
 * Provides structured logging with file output and DEBUG_MODE support.
 * Logs are written to logs/server.log in JSON format.
 *
 * Features:
 * - Structured JSON logging to file for machine parsing
 * - Human-readable console output for immediate visibility
 * - DEBUG_MODE environment variable to control verbosity
 * - Automatic log directory creation
 * - Error handling with fallback to console
 * - Singleton pattern for consistent logging across the application
 *
 * Environment Variables:
 * - DEBUG_MODE: Set to "true" to enable verbose DEBUG level logging (default: false)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

/**
 * Log severity levels
 *
 * Levels are ordered from least to most severe:
 * - DEBUG: Detailed diagnostic information (only shown when DEBUG_MODE=true)
 * - INFO: General informational messages about normal operation
 * - WARNING: Warning messages about potential issues (non-fatal)
 * - ERROR: Error messages about failures that don't stop the server
 * - CRITICAL: Critical errors that may cause the server to stop
 */
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/**
 * Structured log entry format
 *
 * This interface defines the JSON structure written to log files.
 * All fields except timestamp, level, and message are optional.
 * The structured format allows for easy parsing and analysis by log aggregation tools.
 */
export interface LogEntry {
  /** ISO 8601 timestamp when the log entry was created */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** Human-readable log message */
  message: string;
  /** Service name (defaults to "notion-mcp-server") */
  service?: string;
  /** Component/module name (e.g., "auth", "mcp", "session-manager") */
  component?: string;
  /** Additional context data (key-value pairs) */
  metadata?: Record<string, any>;
  /** Error details (if logging an error) */
  error?: {
    /** Error class name (e.g., "TypeError", "Error") */
    name: string;
    /** Error message */
    message: string;
    /** Stack trace (if available) */
    stack?: string;
  };
}

/**
 * Logger class for structured logging
 *
 * This class implements a singleton logger that:
 * - Writes structured JSON logs to a file
 * - Outputs human-readable logs to console
 * - Respects DEBUG_MODE environment variable
 * - Automatically creates log directories
 * - Handles errors gracefully with fallback to console
 */
class Logger {
  /** Full path to the log file (e.g., "/path/to/project/logs/server.log") */
  private logFile: string;
  /** Whether DEBUG level logs should be written (controlled by DEBUG_MODE env var) */
  private debugMode: boolean;
  /** Service name used in all log entries (identifies the application) */
  private serviceName: string = "notion-mcp-server";

  /**
   * Initialize the logger
   *
   * This constructor:
   * 1. Finds the project root directory
   * 2. Creates the logs directory if it doesn't exist
   * 3. Determines the log file path
   * 4. Reads DEBUG_MODE from environment variables
   * 5. Logs its own initialization (meta-logging)
   */
  constructor() {
    /**
     * Find the project root directory
     *
     * We need to find the project root to create logs/server.log relative to it.
     * This ensures logs are always in the same location regardless of where
     * the code is executed from.
     */
    const projectRoot = this.findProjectRoot();
    // Create logs directory path (e.g., "/path/to/project/logs")
    const logDir = path.join(projectRoot, "logs");
    // Create full log file path (e.g., "/path/to/project/logs/server.log")
    this.logFile = path.join(logDir, "server.log");

    /**
     * Ensure log directory exists
     *
     * We create the directory if it doesn't exist to prevent write errors.
     * recursive: true means it will create parent directories if needed.
     * This is safe even if the directory already exists.
     */
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    /**
     * Read DEBUG_MODE from environment variables
     *
     * DEBUG_MODE can be set to "true" or "1" to enable verbose DEBUG logging.
     * This allows users to enable detailed diagnostics without code changes.
     * Default is false (DEBUG logs are skipped unless explicitly enabled).
     */
    this.debugMode =
      process.env.DEBUG_MODE === "true" || process.env.DEBUG_MODE === "1";

    /**
     * Log the logger's own initialization
     *
     * This is meta-logging - the logger logs that it has been initialized.
     * This helps with debugging startup issues and confirms logging is working.
     * We use INFO level because this is expected behavior, not an error.
     */
    this.info("Logger initialized", {
      logFile: this.logFile, // Where logs are being written
      debugMode: this.debugMode, // Whether DEBUG logs are enabled
      nodeEnv: process.env.NODE_ENV || "development", // Current environment
    });
  }

  /**
   * Find the project root directory
   *
   * This method walks up the directory tree from the current file location
   * until it finds a directory containing package.json or tsconfig.json.
   * These files are reliable indicators of a Node.js/TypeScript project root.
   *
   * Why we need this:
   * - We want logs to be in a consistent location (project/logs/server.log)
   * - The code might be executed from different directories
   * - ES modules don't have __dirname, so we use import.meta.url
   *
   * Algorithm:
   * 1. Start at the directory containing this file (src/utils/)
   * 2. Check if package.json or tsconfig.json exists in current directory
   * 3. If found, return current directory (this is the project root)
   * 4. If not found, go up one level and repeat
   * 5. Stop when we reach the filesystem root (currentDir === path.dirname(currentDir))
   * 6. Fallback to process.cwd() if project root not found (shouldn't happen in normal usage)
   *
   * @returns Absolute path to the project root directory
   */
  private findProjectRoot(): string {
    /**
     * Get the directory containing this file (src/utils/)
     *
     * In ES modules, we can't use __dirname (that's a CommonJS feature).
     * Instead, we use import.meta.url which gives us the URL of the current module.
     * fileURLToPath() converts the URL to a file system path.
     *
     * Example: import.meta.url might be "file:///path/to/src/utils/logger.ts"
     *          fileURLToPath() converts it to "/path/to/src/utils/logger.ts"
     */
    const filename = fileURLToPath(import.meta.url);
    // Get the directory containing the file (remove filename, keep directory)
    let currentDir = path.dirname(filename);

    /**
     * Walk up the directory tree until we find the project root
     *
     * We continue until currentDir === path.dirname(currentDir), which means
     * we've reached the filesystem root (e.g., "/" on Unix, "C:\" on Windows).
     * This prevents infinite loops.
     */
    while (currentDir !== path.dirname(currentDir)) {
      /**
       * Check for project root indicators
       *
       * package.json: Standard Node.js project marker
       * tsconfig.json: TypeScript project marker
       *
       * If either exists, we've found the project root.
       */
      const packageJsonPath = path.join(currentDir, "package.json");
      const tsconfigPath = path.join(currentDir, "tsconfig.json");

      // If we find either file, this is the project root
      if (fs.existsSync(packageJsonPath) || fs.existsSync(tsconfigPath)) {
        return currentDir;
      }

      // Go up one directory level and check again
      currentDir = path.dirname(currentDir);
    }

    /**
     * Fallback to current working directory
     *
     * This should rarely happen in normal usage, but provides a safe fallback
     * if the project structure is unusual or files are missing.
     * process.cwd() returns the directory from which the process was started.
     */
    return process.cwd();
  }

  /**
   * Format timestamp in ISO 8601 format
   *
   * ISO 8601 format is: YYYY-MM-DDTHH:mm:ss.sssZ
   * Example: "2024-01-15T10:30:45.123Z"
   *
   * This format is:
   * - Machine-readable (easy to parse)
   * - Human-readable (clear date/time)
   * - Timezone-aware (Z indicates UTC)
   * - Sortable (lexicographic order matches chronological order)
   *
   * @returns ISO 8601 formatted timestamp string
   */
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Write log entry to file
   *
   * This method writes a structured JSON log entry to the log file.
   * Each log entry is a single line of JSON, making it easy to parse
   * with line-by-line JSON parsers (common in log aggregation tools).
   *
   * Error handling:
   * - If file write fails (e.g., disk full, permissions), we fall back to console
   * - This ensures logs are never completely lost, even if file I/O fails
   * - We log the error to console so users know logging to file failed
   *
   * @param entry - The structured log entry to write
   */
  private writeToFile(entry: LogEntry): void {
    try {
      /**
       * Convert log entry to JSON string and append newline
       *
       * JSON.stringify() converts the LogEntry object to a JSON string.
       * We append "\n" to create a newline-delimited JSON format (NDJSON),
       * which is a common format for log files. Each line is a complete
       * JSON object, making it easy to parse line by line.
       */
      const logLine = JSON.stringify(entry) + "\n";
      /**
       * Append log line to file
       *
       * appendFileSync() is synchronous, which means it blocks until the write
       * completes. This ensures logs are written immediately and in order.
       * We use "utf-8" encoding to ensure proper character handling.
       */
      fs.appendFileSync(this.logFile, logLine, "utf-8");
    } catch (error) {
      /**
       * Fallback to console if file write fails
       *
       * This can happen if:
       * - Disk is full
       * - Insufficient permissions
       * - Log file is locked by another process
       * - Network filesystem issues
       *
       * We don't throw the error because logging failures shouldn't crash the server.
       * Instead, we output to console as a fallback, ensuring logs aren't completely lost.
       */
      console.error("Failed to write to log file:", error);
      console.error("Log entry:", entry);
    }
  }

  /**
   * Format log entry for console output (human-readable)
   *
   * This method converts a structured LogEntry into a human-readable string
   * suitable for console output. The format is designed to be:
   * - Easy to read at a glance
   * - Compact (fits on one line when possible)
   * - Informative (includes timestamp, level, message, metadata, errors)
   *
   * Format: [YYYY-MM-DD HH:mm:ss] LEVEL    message {metadata}
   *         Error: ErrorName: error message
   *
   * Example: [2024-01-15 10:30:45] INFO     Server started {port: 3000}
   *          [2024-01-15 10:30:46] ERROR    Failed to connect
   *            Error: ConnectionError: Connection refused
   *
   * @param entry - The structured log entry to format
   * @returns Human-readable log string for console output
   */
  private formatForConsole(entry: LogEntry): string {
    /**
     * Format timestamp for human readability
     *
     * Convert ISO 8601 format to a more readable format:
     * - "2024-01-15T10:30:45.123Z" -> "2024-01-15 10:30:45"
     * - Replace "T" with space (separates date and time)
     * - Remove milliseconds and timezone (".123Z") for cleaner output
     */
    const timestamp = entry.timestamp
      .replace("T", " ") // Replace T separator with space
      .replace(/\.\d{3}Z$/, ""); // Remove milliseconds and Z timezone indicator
    /**
     * Format log level with padding
     *
     * padEnd(8) ensures all levels are the same width (8 characters),
     * making the output aligned and easier to scan visually.
     * Example: "DEBUG   ", "INFO    ", "WARNING ", "ERROR   "
     */
    const level = entry.level.padEnd(8);
    /** The main log message */
    const message = entry.message;
    /**
     * Format metadata as JSON string
     *
     * If metadata exists, convert it to a JSON string and prepend a space.
     * This allows additional context to be included in the log output.
     * Example: {port: 3000, component: "server"} -> " {"port":3000,"component":"server"}"
     */
    const metadata = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
    /**
     * Format error information
     *
     * If an error is present, format it on a new line with indentation.
     * This makes errors stand out and keeps the main message line clean.
     * Example: "\n  Error: TypeError: Cannot read property 'x' of undefined"
     */
    const error = entry.error
      ? `\n  Error: ${entry.error.name}: ${entry.error.message}`
      : "";

    /**
     * Combine all parts into final formatted string
     *
     * The format is: [timestamp] level message metadata error
     * This creates a consistent, scannable log format that's easy to read.
     */
    return `[${timestamp}] ${level} ${message}${metadata}${error}`;
  }

  /**
   * Internal log method (core logging logic)
   *
   * This is the central method that all public logging methods (debug, info, etc.)
   * call. It handles:
   * 1. Filtering DEBUG logs based on DEBUG_MODE
   * 2. Creating structured log entries
   * 3. Writing to file
   * 4. Outputting to console with appropriate level
   *
   * @param level - Log severity level
   * @param message - Human-readable log message
   * @param metadata - Optional additional context data
   * @param error - Optional Error object to include error details
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): void {
    /**
     * Skip DEBUG logs if DEBUG_MODE is not enabled
     *
     * DEBUG logs are verbose and can be noisy. We only write them when
     * explicitly enabled via DEBUG_MODE environment variable. This allows
     * users to enable detailed diagnostics when needed without code changes.
     *
     * Early return prevents unnecessary processing when DEBUG logs are disabled.
     */
    if (level === "DEBUG" && !this.debugMode) {
      return;
    }

    /**
     * Create structured log entry
     *
     * We build a LogEntry object with all available information:
     * - timestamp: Current time in ISO 8601 format
     * - level: Log severity level
     * - message: Human-readable message
     * - service: Service name (identifies the application)
     * - component: Component name from metadata (e.g., "auth", "mcp")
     * - metadata: Additional context (excluding component, which is extracted)
     * - error: Error details if an error was provided
     */
    const entry: LogEntry = {
      /** Current timestamp in ISO 8601 format */
      timestamp: this.formatTimestamp(),
      /** Log severity level */
      level,
      /** Human-readable log message */
      message,
      /** Service name (identifies the application) */
      service: this.serviceName,
      /**
       * Extract component from metadata
       *
       * The component field is a special metadata field that identifies
       * which part of the application generated the log (e.g., "auth", "mcp").
       * We extract it from metadata and put it in its own field for easier filtering.
       */
      component: metadata?.component,
      /**
       * Store metadata (excluding component, which is extracted above)
       *
       * We create a copy of metadata and remove the component field to avoid
       * duplication. If metadata exists, we spread it and set component to undefined.
       * If metadata doesn't exist, we set it to undefined.
       */
      metadata: metadata ? { ...metadata, component: undefined } : undefined,
      /**
       * Extract error information if an error was provided
       *
       * We extract the error's name, message, and stack trace into a structured
       * format. This makes errors easier to parse and analyze in log aggregation tools.
       * The stack trace is optional because some errors might not have one.
       */
      error: error
        ? {
            name: error.name, // Error class name (e.g., "TypeError", "Error")
            message: error.message, // Error message
            stack: error.stack, // Stack trace (if available)
          }
        : undefined,
    };

    /**
     * Write structured log entry to file
     *
     * This writes the log as JSON to the log file. The file format is
     * newline-delimited JSON (NDJSON), where each line is a complete JSON object.
     * This format is easy to parse and is supported by most log aggregation tools.
     */
    this.writeToFile(entry);

    /**
     * Format and output to console for immediate visibility
     *
     * We also output logs to the console so developers can see them immediately
     * during development and debugging. The console output is human-readable,
     * while the file output is structured JSON for machine parsing.
     */
    const consoleMessage = this.formatForConsole(entry);

    /**
     * Output to console using appropriate method based on log level
     *
     * We use different console methods to match the log severity:
     * - DEBUG/INFO: console.log() (normal output)
     * - WARNING: console.warn() (warning output, may be styled differently)
     * - ERROR/CRITICAL: console.error() (error output, may be styled differently)
     *
     * This allows terminals and log viewers to color-code or filter logs by level.
     */
    switch (level) {
      case "DEBUG":
      case "INFO":
        console.log(consoleMessage);
        break;
      case "WARNING":
        console.warn(consoleMessage);
        break;
      case "ERROR":
      case "CRITICAL":
        console.error(consoleMessage);
        break;
    }
  }

  /**
   * Log DEBUG message (only if DEBUG_MODE is enabled)
   *
   * DEBUG logs contain detailed diagnostic information useful for troubleshooting.
   * They are only written when DEBUG_MODE environment variable is set to "true" or "1".
   * This prevents log files from becoming too large in production.
   *
   * Use DEBUG for:
   * - Detailed function entry/exit
   * - Variable values during execution
   * - Internal state changes
   * - Performance metrics
   *
   * @param message - Human-readable debug message
   * @param metadata - Optional additional context (e.g., {component: "auth", userId: "123"})
   */
  debug(message: string, metadata?: Record<string, any>): void {
    this.log("DEBUG", message, metadata);
  }

  /**
   * Log INFO message
   *
   * INFO logs contain general informational messages about normal operation.
   * They are always written (not filtered by DEBUG_MODE).
   *
   * Use INFO for:
   * - Server startup/shutdown
   * - Configuration loaded
   * - Successful operations
   * - Important state changes
   *
   * @param message - Human-readable info message
   * @param metadata - Optional additional context
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.log("INFO", message, metadata);
  }

  /**
   * Log WARNING message
   *
   * WARNING logs indicate potential issues that don't prevent the server from functioning.
   * They are always written and should be investigated but aren't urgent.
   *
   * Use WARNING for:
   * - Deprecated feature usage
   * - Performance degradation
   * - Configuration issues (with fallbacks)
   * - Recoverable errors
   *
   * @param message - Human-readable warning message
   * @param metadata - Optional additional context
   */
  warning(message: string, metadata?: Record<string, any>): void {
    this.log("WARNING", message, metadata);
  }

  /**
   * Log ERROR message
   *
   * ERROR logs indicate failures that don't stop the server but should be addressed.
   * They are always written and typically include error details.
   *
   * Use ERROR for:
   * - Failed operations (with retries)
   * - Invalid input handling
   * - External service failures
   * - Recoverable exceptions
   *
   * @param message - Human-readable error message
   * @param metadata - Optional additional context
   * @param error - Optional Error object to include error details (name, message, stack)
   */
  error(message: string, metadata?: Record<string, any>, error?: Error): void {
    this.log("ERROR", message, metadata, error);
  }

  /**
   * Log CRITICAL message
   *
   * CRITICAL logs indicate severe failures that may cause the server to stop or
   * lose data. They are always written and require immediate attention.
   *
   * Use CRITICAL for:
   * - Unrecoverable errors
   * - Data corruption
   * - Security violations
   * - System-level failures
   *
   * @param message - Human-readable critical error message
   * @param metadata - Optional additional context
   * @param error - Optional Error object to include error details
   */
  critical(
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): void {
    this.log("CRITICAL", message, metadata, error);
  }
}

/**
 * Export singleton logger instance
 *
 * We create a single Logger instance and export it as a singleton.
 * This ensures:
 * - All parts of the application use the same logger configuration
 * - Log file path and DEBUG_MODE are consistent across the application
 * - No need to pass logger instances around or create multiple loggers
 *
 * The singleton is created immediately when this module is imported,
 * so the logger is ready to use as soon as the module loads.
 */
export const logger = new Logger();

/**
 * Export convenience functions for functional-style logging
 *
 * These functions provide an alternative API for logging that doesn't require
 * importing the logger object. They're useful for:
 * - Functional programming style
 * - Shorter import statements
 * - Consistency with other utility functions
 *
 * Usage examples:
 *   import { logInfo, logError } from './logger';
 *   logInfo("Server started", {port: 3000});
 *   logError("Failed to connect", {component: "db"}, error);
 *
 * These functions are thin wrappers around the logger singleton methods.
 */
export const logDebug = (message: string, metadata?: Record<string, any>) =>
  logger.debug(message, metadata);
export const logInfo = (message: string, metadata?: Record<string, any>) =>
  logger.info(message, metadata);
export const logWarning = (message: string, metadata?: Record<string, any>) =>
  logger.warning(message, metadata);
export const logError = (
  message: string,
  metadata?: Record<string, any>,
  error?: Error
) => logger.error(message, metadata, error);
export const logCritical = (
  message: string,
  metadata?: Record<string, any>,
  error?: Error
) => logger.critical(message, metadata, error);
