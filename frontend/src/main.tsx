// Vercel's Hobby plan will not build a commit authored by anyone who is not a
// project member, so pushes from other collaborators sit blocked. Vercel also
// skips a build entirely when nothing under the configured root directory
// (frontend/) changed, which is why an empty commit does not release them
// either. Touching a real file here is what actually ships the blocked work.
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
