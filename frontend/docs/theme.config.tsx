import { DocsThemeConfig } from 'nextra-theme-docs'
import React from 'react'

const Logo = () => (
  <span
    style={{
      fontFamily: "'Lora', Georgia, serif",
      fontWeight: 600,
      fontStyle: 'italic',
      fontSize: '1.15rem',
      color: '#FDDA24',
      letterSpacing: '-0.01em',
    }}
  >
    Veil
  </span>
)

const config: DocsThemeConfig = {
  logo: <Logo />,

  project: {
    link: 'https://github.com/Miracle656/veil',
  },

  docsRepositoryBase:
    'https://github.com/Miracle656/veil/tree/main/frontend/docs',

  footer: {
    text: (
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '0.75rem', color: '#D6D2C4' }}>
        © {new Date().getFullYear()} Veil — Powered by Stellar Soroban · WebAuthn / FIDO2 · MIT
      </span>
    ),
  },

  useNextSeoProps() {
    return { titleTemplate: '%s – Veil Docs' }
  },

  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta
        name="description"
        content="Veil — Passkey-powered Stellar smart wallet. SDK reference, contract API, and architecture docs."
      />
      <link
        href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500&family=Anton&display=swap"
        rel="stylesheet"
      />
    </>
  ),

  sidebar: {
    defaultMenuCollapseLevel: 1,
  },

  toc: {
    backToTop: true,
  },

  editLink: {
    text: 'Edit this page on GitHub',
  },

  feedback: {
    content: 'Question? Give us feedback',
    labels: 'feedback',
  },

  banner: {
    key: 'phase-3-v3',
    text: (
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '0.82rem' }}>
        Phase 3 (Factory Contract) is open for contributors —{' '}
        <a
          href="https://github.com/Miracle656/veil/issues"
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'underline', color: '#FDDA24' }}
        >
          see open issues
        </a>
      </span>
    ),
  },
}

export default config
