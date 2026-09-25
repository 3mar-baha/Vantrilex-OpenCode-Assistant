import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { KeysView } from './components/settings/KeysView.js';
import { AGENT_CHAIN } from './settings/chain.js';
import { isKeysView, isSettingsView } from './settings/open-settings.js';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Voxaura: #root element missing');

// Three surfaces, one bundle: the companion HUD, the general settings window
// (?view=settings), and the focused API-keys window (?view=keys).
const params = new URLSearchParams(window.location.search);
const persona = params.get('persona') === 'nour' ? 'nour' : 'kareem';

function surface(): JSX.Element {
  if (isKeysView()) return <KeysView />;
  if (isSettingsView()) return <SettingsView chain={[...AGENT_CHAIN]} initialPersona={persona} />;
  return <App />;
}

createRoot(root).render(<React.StrictMode>{surface()}</React.StrictMode>);