import '@fontsource/michroma/400.css';
import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { initRepairTool } from './repair/tool.js';
import { registerServiceWorker, setUpInstallButton, receiveFiles } from './app.js';

registerServiceWorker();
setUpInstallButton(document.getElementById('install-app'));

const fixer = document.getElementById('fixer');
if (fixer) receiveFiles(initRepairTool(fixer).open);
