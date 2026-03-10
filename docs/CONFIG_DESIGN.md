# Tianji AI Configuration Design v1

> Status: Draft v1  
> Scope: Detailed configuration mechanics for `tianji-ai`  
> Related: [`./ARCHITECTURE_V1.md`](./ARCHITECTURE_V1.md)

---

## 1. Purpose

This document defines **how configuration is stored, loaded, merged, validated, and resolved** in `tianji-ai`.

The main architecture document remains the source of truth for:

- ownership boundaries
- runtime invariants
- cancellation / snapshot truth
- delta / event semantics
- tool path-security rules

This document focuses on the operational mechanics of configuration.

---

## 2. Design Principles

1. **Configuration is JSON-first**  
   User-visible configuration lives in JSON files, not scattered environment variables.

2. **Secrets are env-backed**  
   Sensitive values are injected from environment variables via placeholders.

3. **Runtime resolves configuration once**  
   `packages/runtime` is the only component that merges config layers and resolves placeholders.

4. **Schema lives in `packages/shared`**  
   Type definitions, validation schemas, migration helpers, and placeholder syntax rules are defined in `packages/shared`.

5. **Later layers override earlier layers**  
   Override behavior is deterministic and field-based.

---

## 3. Configuration Layers

`tianji-ai` uses three JSON config layers.

### 3.1 Project Layer

Path:

```text
<project-root>/tianji.config.json
```

Role:

- project defaults
- team-shared behavior
- default model routing
- default tool policy
- default observer settings

This is the **factory/default** configuration for a repository.

### 3.2 User Layer

Path:

```text
~/.config/tianji-ai/tianji.json
```

Role:

- user-wide overrides
- personal defaults across repositories
- preferred providers, UI-related defaults, personal non-secret settings

This layer overrides the project layer.

### 3.3 Workspace Layer

Path:

```text
~/.config/tianji-ai/workspaces/<workspace-id>.json
```

Role:

- workspace-specific overrides
- repo-local user behavior
- local exceptions for tools, models, or runtime settings

This layer overrides both project and user layers.

---

## 4. Precedence Rules

From low to high priority:

1. project layer
2. user layer
3. workspace layer

In shorthand:

> **project < user < workspace**

Rules:

- later layers overwrite earlier fields with the same path
- absent fields fall back to lower layers
- invalid higher-layer config must fail validation rather than silently falling back
- runtime must expose the final resolved view as `ResolvedConfig`

---

## 5. Environment Variable Placeholders

Environment variables are **not a fourth config layer**.

They are only used for:

- API keys
- tokens / secrets
- sensitive endpoints / credentials
- optional bootstrap values (for example, a custom config path)

### 5.1 Placeholder Syntax

JSON may reference env values using placeholders:

```json
{
  "llm": {
    "providers": {
      "openai": {
        "apiKey": "${env:OPENAI_API_KEY}"
      }
    }
  }
}
```

Suggested v1 syntax:

- `${env:VAR_NAME}`

v1 does **not** need a full template language. A single explicit env placeholder syntax is enough.

### 5.2 Resolution Rules

Runtime resolves placeholders **after JSON merge, before final config becomes active**.

Rules:

- unresolved placeholder => configuration error
- empty string env value is treated as an explicit resolved value, not “missing”
- placeholders are only resolved in string values
- resolved secret values must not be written back to JSON files
- logs and diagnostics must redact resolved secret values

---

## 6. Runtime Loading Pipeline

The runtime loader should execute the following pipeline:

1. read project config JSON
2. read user config JSON
3. read workspace config JSON
4. merge them in precedence order
5. validate merged raw structure against schema
6. resolve `${env:VAR_NAME}` placeholders
7. build `ResolvedConfig`
8. distribute `ResolvedConfig` to `llm`, `tools-node`, `observer`, and apps

Important:

- merging and env resolution must happen in one central loader
- internal packages must not independently read config files or env
- runtime should expose both the raw-source metadata and the resolved config snapshot for diagnostics

---

## 7. Workspace ID Mapping

`<workspace-id>` should be derived from the workspace root path using a stable mapping.

Requirements:

- same workspace path always maps to the same ID
- different workspace paths must not collide in practice
- ID must be filesystem-safe

Recommended pattern:

- normalized absolute workspace path
- hashed into a short stable identifier

The human-readable source path should remain visible in metadata for debugging.

---

## 8. Suggested Top-Level Config Shape

The exact schema may evolve, but v1 should converge around a shape similar to:

```json
{
  "llm": {
    "defaultProvider": "openai",
    "defaultModel": "gpt-4.1",
    "providers": {
      "openai": {
        "apiKey": "${env:OPENAI_API_KEY}"
      }
    }
  },
  "runtime": {
    "retry": {
      "maxAttempts": 2,
      "baseDelayMs": 300,
      "maxDelayMs": 3000
    },
    "tool": {
      "timeoutMs": 120000,
      "maxConcurrency": 4,
      "allowDestructive": false,
      "pathPolicy": {
        "forbidDirectories": [
          ".git/",
          "node_modules/"
        ],
        "filenameDenyPatterns": [
          "^\\.env($|\\.)",
          "(^|/)id_rsa$"
        ]
      }
    }
  },
  "observer": {
    "enabled": true,
    "redactSecrets": true
  }
}
```

This example is illustrative, not normative for every default value.

---

## 9. Merge Semantics

Suggested v1 semantics:

- **object fields**: deep merge
- **scalar fields**: replace
- **arrays**: replace by default

Why arrays replace instead of merge:

- simpler to reason about
- avoids accidental deny/allow list duplication
- easier to debug effective configuration

If future use cases require smarter merges, they should be introduced field-by-field rather than globally.

---

## 10. Validation and Error Handling

Validation must fail fast when:

- JSON is malformed
- unknown required structure is missing
- placeholder syntax is invalid
- env placeholder is unresolved
- a higher-precedence config introduces invalid data

Recommended error categories:

- `config.parse_error`
- `config.schema_error`
- `config.placeholder_error`
- `config.env_missing`
- `config.workspace_resolution_error`

Diagnostics should report:

- which file contributed the invalid field
- field path
- expected type or rule
- whether the error happened before or after env resolution

---

## 11. Non-Goals for v1

v1 does **not** aim to provide:

- dynamic remote config service
- hot reload across all runtimes
- arbitrary expression language inside JSON
- role-based multi-tenant config inheritance
- plugin-defined config files scattered across packages

---

## 12. Summary

`tianji-ai` v1 uses:

- **three JSON config layers** for defaults and overrides
- **env placeholders** for sensitive values
- **runtime-owned resolution** for final effective config

In one line:

> Project defaults live in `tianji.config.json`, user and workspace JSON files override them, and runtime resolves env placeholders into a single `ResolvedConfig`.
