import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        chrome: "readonly",
        browser: "readonly",
      },
    },
    ignores: ["dist/**", "node_modules/**", "test/**", "fixtures/**", "website/**", "backend/**"],
  },
];
