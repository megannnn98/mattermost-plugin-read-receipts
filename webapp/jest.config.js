/** @type {import('ts-jest').JestConfigWithTsJest} */
const common = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest',
    },
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
};

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    projects: [
        {
            ...common,
            displayName: 'react18',
            roots: ['<rootDir>/tests'],
            testMatch: ['**/*.test.ts', '**/*.test.tsx'],
            testPathIgnorePatterns: ['<rootDir>/tests/react17/'],
        },
        {
            ...common,
            displayName: 'react17',
            roots: ['<rootDir>/tests/react17'],
            testMatch: ['**/*.test.ts', '**/*.test.tsx'],
            moduleNameMapper: {
                ...common.moduleNameMapper,
                '^react$': 'react17',
                '^react-dom$': 'react-dom17',
                '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom17/$1',
            },
        },
    ],
};
