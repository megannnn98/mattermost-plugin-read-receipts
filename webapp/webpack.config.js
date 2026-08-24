const path = require('path');

module.exports = (env, argv) => {
    const mode = argv.mode || 'production';
    return {
        entry: './src/index.tsx',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'main.js',
            library: {
                type: 'umd',
            },
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.jsx'],
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    test: /\.css$/,
                    use: ['style-loader', 'css-loader'],
                },
            ],
        },
        mode,
        devtool: mode === 'development' ? 'source-map' : false,
        externals: {
            react: 'React',
            'react-dom': 'ReactDOM',
        },
    };
};
