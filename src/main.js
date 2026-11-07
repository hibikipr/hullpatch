import '@fontsource/michroma/400.css';
import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './theme.css';
import { initRepairTool } from './repair/tool.js';

const fixer = document.getElementById('fixer');
if (fixer) initRepairTool(fixer);
