#!/usr/bin/env bun
// Retained as an explicit migration notice for existing operator commands.
console.error('Retired: v1 loads instrument titles from D1 and caches them per published revision. Do not seed the legacy KV title list.');
process.exitCode = 1;
