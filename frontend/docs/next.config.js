const nextra = require('nextra')

/** @type {import('nextra').NextraConfig} */
const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})

module.exports = withNextra({
  reactStrictMode: true,
})
