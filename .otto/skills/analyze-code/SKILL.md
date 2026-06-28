---
name: analyze-code
description: Deep-dive analysis of a specific file or module with architecture context, complexity ratings, and dependency mapping
argument-hint: ["[file-path]"]
---

# /analyze-code

Perform a thorough analysis of the specified file or module.

## Instructions

1. **Resolve the target**: Parse `$ARGUMENTS` for the file path. If no path is given, analyze the current active file or ask the user.

2. **Read the file**: Use the read_file tool to load the target file's contents.

3. **Structural Analysis**: Identify and document:
   - All exported functions, classes, and types
   - Import dependencies (internal project files vs external packages)
   - Complexity assessment (simple / moderate / complex / critical)
   - Lines of code and comment density

4. **Dependency Mapping**: Trace what this file imports and what imports this file:
   - Use search_code to find all files that reference/import the target
   - Build a 1-hop dependency graph showing upstream (callers) and downstream (dependencies)

5. **Architecture Layer**: Determine which architectural layer this file belongs to:
   - API / Route layer
   - Service / Business logic layer
   - Data / Repository layer
   - Utility / Helper layer
   - Configuration / Infrastructure layer
   - UI / Presentation layer

6. **Output Report**: Generate a structured markdown report in `.otto/brain/analysis.md` with:
   - File overview and purpose
   - Dependency graph (ascii or mermaid)
   - Complexity rating with justification
   - Suggestions for improvement (if any)
   - Key patterns or idioms used

7. **Summary**: Print a concise summary to the chat highlighting the most important findings.
