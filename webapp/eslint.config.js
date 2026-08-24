const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const reactPlugin = require('eslint-plugin-react');

module.exports = [
    {
        files: ['src/**/*.ts', 'src/**/*.tsx'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: 'module',
                ecmaFeatures: {jsx: true},
            },
            globals: {
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                IntersectionObserver: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            react: reactPlugin,
        },
        settings: {react: {version: 'detect'}},
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            eqeqeq: ['error', 'always'],
            'no-console': ['warn', {allow: ['debug', 'warn', 'error']}],
            'react/jsx-uses-react': 'error',
            'react/jsx-uses-vars': 'error',
        },
    },
];
