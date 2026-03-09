import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["node_modules/**", "dist/**", ".next/**", "build/**", "bun.lock", "apps/web/**", "**/eslint.config.*", ".stryker-tmp/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "max-lines-per-function": ["error", { max: 32, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 3],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-empty-function": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },
  // FFI bridge: 1:1 mapping to libaacyn.c symbols — naturally long, can't split without breaking the mirror
  {
    files: ["**/lib/native-store.ts"],
    rules: {
      "max-lines": "off",
    },
  },
  // Test files: relax function-length (setup is inherently linear) but keep all other gates
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
];
