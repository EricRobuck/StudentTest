import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { InstructorApp } from './instructor/InstructorApp';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

// /instructor… is the instructor area; everything else is the student exam.
// (The student page starts an exam session on load, so it must not render here.)
const isInstructor = window.location.pathname.startsWith('/instructor');
document.title = isInstructor ? 'Linux Lab · Instructor' : 'Linux Practical Exam';

createRoot(rootElement).render(<StrictMode>{isInstructor ? <InstructorApp /> : <App />}</StrictMode>);
