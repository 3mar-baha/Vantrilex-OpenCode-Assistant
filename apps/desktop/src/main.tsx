import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { AGENT_CHAIN } from './settings/chain.js';
import { isSettingsView } from './settings/open-settings.js';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Voxaura: #root element missing');

// Two surfaces, one bundle: the companion HUD, and the dedicated settings
// window (?view=settings) which renders only the settings panel.
const params = new URLSearchParams(window.location.search);
const persona = params.get('persona') === 'nour' ? 'nour' : 'kareem';

createRoot(root).render(
  <React.StrictMode>
    {isSettingsView() ? <SettingsView chain={[...AGENT_CHAIN]} initialPersona={persona} /> : <App />}
  </React.StrictMode>,
);