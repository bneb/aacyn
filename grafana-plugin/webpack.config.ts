import path from 'path';
import CopyPlugin from 'copy-webpack-plugin';

export default (env: { production?: boolean }) => ({
    mode: env.production ? 'production' : 'development',
    entry: './src/module.ts',
    output: {
        filename: 'module.js',
        path: path.resolve(__dirname, 'dist'),
        libraryTarget: 'amd',
        clean: true,
    },
    externals: [
        'react',
        'react-dom',
        '@grafana/data',
        '@grafana/runtime',
        '@grafana/ui',
        '@grafana/schema',
        'lodash',
        'jquery',
    ],
    resolve: {
        extensions: ['.ts', '.tsx', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'src/plugin.json', to: '.' },
            ],
        }),
    ],
});
