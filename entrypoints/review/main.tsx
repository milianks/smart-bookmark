import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewApp } from '../../components/ReviewApp';
import '../../components/styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ReviewApp /></React.StrictMode>);
