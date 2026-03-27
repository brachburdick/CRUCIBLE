import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import Dashboard from './pages/Dashboard'
import RunDetail from './pages/RunDetail'
import Session from './pages/Session'
import Projects from './pages/Projects'
import GraphList from './pages/GraphList'
import GraphView from './pages/GraphView'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/session" element={<Session />} />
        <Route path="/graphs" element={<GraphList />} />
        <Route path="/graphs/:id" element={<GraphView />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
