/**
 * Logger Utility for Notion MCP Server
 *
 * Provides structured logging with file output and DEBUG_MODE support.
 * Logs are written to logs/server.log in JSON format.
 *
 * Environment Variables:
 * - DEBUG_MODE: Set to "true" to enable verbose DEBUG level logging (default: false)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  component?: string;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class Logger {
  private logFile: string;
  private debugMode: boolean;
  private serviceName: string = "notion-mcp-server";

  constructor() {
    // Determine log file path (relative to project root)
    const projectRoot = this.findProjectRoot();
    const logDir = path.join(projectRoot, "logs");
    this.logFile = path.join(logDir, "server.log");

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Read DEBUG_MODE from environment
    this.debugMode =
      process.env.DEBUG_MODE === "true" || process.env.DEBUG_MODE === "1";

    // Log initialization
    this.info("Logger initialized", {
      logFile: this.logFile,
      debugMode: this.debugMode,
      nodeEnv: process.env.NODE_ENV || "development",
    });
  }

  /**
   * Find the project root by looking for package.json or tsconfig.json
   *
   * Since this is an ES module, we use import.meta.url instead of __dirname
   */
  private findProjectRoot(): string {
    // Get the directory containing this file (src/utils/)
    // In ES modules, we use import.meta.url to get the current file's URL
    const filename = fileURLToPath(import.meta.url);
    let currentDir = path.dirname(filename);

    // Go up from src/utils/logger.ts to project root
    // We need to go up two levels: src/utils/ -> src/ -> project root
    while (currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, "package.json");
      const tsconfigPath = path.join(currentDir, "tsconfig.json");

      if (fs.existsSync(packageJsonPath) || fs.existsSync(tsconfigPath)) {
        return currentDir;
      }

      currentDir = path.dirname(currentDir);
    }

    // Fallback to current working directory
    return process.cwd();
  }

  /**
   * Format timestamp in ISO 8601 format
   */
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Write log entry to file
   */
  private writeToFile(entry: LogEntry): void {
    try {
      const logLine = JSON.stringify(entry) + "\n";
      fs.appendFileSync(this.logFile, logLine, "utf-8");
    } catch (error) {
      // Fallback to console if file write fails
      console.error("Failed to write to log file:", error);
      console.error("Log entry:", entry);
    }
  }

  /**
   * Format log entry for console output (human-readable)
   */
  private formatForConsole(entry: LogEntry): string {
    const timestamp = entry.timestamp
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const level = entry.level.padEnd(8);
    const message = entry.message;
    const metadata = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
    const error = entry.error
      ? `\n  Error: ${entry.error.name}: ${entry.error.message}`
      : "";

    return `[${timestamp}] ${level} ${message}${metadata}${error}`;
  }

  /**
   * Internal log method
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): void {
    // Skip DEBUG logs if DEBUG_MODE is not enabled
    if (level === "DEBUG" && !this.debugMode) {
      return;
    }

    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      message,
      service: this.serviceName,
      component: metadata?.component,
      metadata: metadata ? { ...metadata, component: undefined } : undefined,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
    };

    // Write to file
    this.writeToFile(entry);

    // Also output to console (for immediate visibility)
    const consoleMessage = this.formatForConsole(entry);

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
   */
  debug(message: string, metadata?: Record<string, any>): void {
    this.log("DEBUG", message, metadata);
  }

  /**
   * Log INFO message
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.log("INFO", message, metadata);
  }

  /**
   * Log WARNING message
   */
  warning(message: string, metadata?: Record<string, any>): void {
    this.log("WARNING", message, metadata);
  }

  /**
   * Log ERROR message
   */
  error(message: string, metadata?: Record<string, any>, error?: Error): void {
    this.log("ERROR", message, metadata, error);
  }

  /**
   * Log CRITICAL message
   */
  critical(
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): void {
    this.log("CRITICAL", message, metadata, error);
  }
}

// Export singleton instance
export const logger = new Logger();

// Export convenience functions
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
