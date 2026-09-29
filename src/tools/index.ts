import { editFileTool, writeFileTool } from './filesystem/edit.js'
import { fileInfoTool, globTool, listDirectoryTool } from './filesystem/list.js'
import { deleteFileTool, moveFileTool } from './filesystem/mutate.js'
import { readFileTool } from './filesystem/read.js'
import { searchRegexTool, searchTextTool } from './filesystem/search.js'
import { findSymbolTool } from './filesystem/symbols.js'
import { gitDiffTool, gitLogTool, gitStatusTool } from './git/index.js'
import { recallTool, rememberTool } from './memory/index.js'
import { todoTool } from './planning/todo.js'
import type { ToolRegistry } from './registry.js'
import { checkOutputTool, killProcessTool, runCommandTool } from './shell/run.js'
import { webFetchTool, webSearchTool } from './web/index.js'

/**
 * The built-in tool set.
 *
 * Registration order is the order the model sees them, so it is grouped by
 * category: read before write, search before shell. That ordering nudges the
 * model toward investigating before acting, which is the behaviour we want
 * reinforced by default rather than by instruction alone.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.registerAll([
    // filesystem — read
    readFileTool,
    listDirectoryTool,
    fileInfoTool,
    globTool,
    // search
    searchTextTool,
    searchRegexTool,
    findSymbolTool,
    // filesystem — write
    editFileTool,
    writeFileTool,
    moveFileTool,
    deleteFileTool,
    // git — read-only views
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    // shell
    runCommandTool,
    checkOutputTool,
    killProcessTool,
    // web research
    webSearchTool,
    webFetchTool,
    // planning and memory
    todoTool,
    recallTool,
    rememberTool,
  ])
}

export {
  editFileTool,
  globTool,
  readFileTool,
  runCommandTool,
  searchTextTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
}
