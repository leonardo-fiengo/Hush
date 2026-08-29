import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/newsreader/latin-500-italic.css'
import '@fontsource/dm-mono/latin-400.css'
import '@fontsource/dm-mono/latin-500.css'
import App from '../../src/App.jsx'
import { extensionVaultApi } from '../../src/lib/extensionVaultApi.js'
import '../../src/styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App vaultApi={extensionVaultApi} runtime="extension" />
  </React.StrictMode>,
)
