const path = require('node:path');
const { DefinePlugin } = require('webpack');
const { VueLoaderPlugin } = require('vue-loader');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CompressionDictionaryPlugin = require('./webpack/CompressionDictionaryPlugin.cjs');
const CompressionDictionaryPluginProd = require('./webpack/production/CompressionDictionaryPlugin.cjs');

module.exports = {
  entry: './src/main.js',
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: 'dist/app.[contenthash:16].js',
    publicPath: '/',
    clean: true,
  },
  devtool: false,
  module: {
    rules: [
      { test: /\.vue$/, loader: 'vue-loader' },
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
    ],
  },
  optimization: {
    minimizer: ['...', new CssMinimizerPlugin({
      minimizerOptions: { preset: ['default', { discardComments: { all: true } }] },
    })],
  },
  plugins: [
    new VueLoaderPlugin(),
    new DefinePlugin({
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    }),
    new MiniCssExtractPlugin({ filename: 'dist/styles.[contenthash:16].css' }),
    new HtmlWebpackPlugin({ template: 'public/index.html' }),
    new CompressionDictionaryPlugin({
      dictionarySource: path.resolve(__dirname, 'dictionaries/styles.v1.css'),
      match: '/dist/styles.*.css',
    }),
    //Ray-Ban CSS example
    new CompressionDictionaryPluginProd({
      input: path.resolve(__dirname, 'src/styles.3772401f5d.css'),
      dictionarySource: path.resolve(__dirname, 'dictionaries/styles.3772401f5d.dat'),
      // dictionaryFilename: 'dictionaries/styles.[hash].dat',
      dcbFilename: 'dist/styles.[hash].css.dcb',
    }),
  ],
};
