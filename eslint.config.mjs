import tseslint from "typescript-eslint";

export default [
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-console": "error",
      "eqeqeq": ["error", "always"],
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "build/**"],
  },
];
