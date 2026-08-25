/*
 * MacOS Workspaces — lint rules
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Matches the GNOME Shell house style the extension is written in, since that
 * is what an extensions.gnome.org reviewer will be reading it against.
 */
export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // GJS provides these; none of them are Node or browser globals.
                console: 'readonly',
                global: 'readonly',
                globalThis: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
            },
        },
        linterOptions: {reportUnusedDisableDirectives: true},
        rules: {
            'no-unused-vars': 'error',
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'indent': ['error', 4, {SwitchCase: 1}],
            'max-len': ['error', {code: 100, ignoreUrls: true}],
            'comma-dangle': ['error', 'always-multiline'],
            'eqeqeq': 'error',
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
        },
    },
];
