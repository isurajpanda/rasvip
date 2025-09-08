
    'use strict';

    document.addEventListener('DOMContentLoaded', () => {

        // Setup the worker for PDF.js library to run parsing in a separate thread.
        if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;
        }


        // --- State Management & Constants ---

        // Central object to hold the application's current state.
        const AppState = {
            wordsOnly: [],          // Array of all words from the document.
            currentItemIndex: 0,    // Index of the currently displayed word.
            pauseMap: {},           // Maps word indices to pause multipliers (for punctuation).
            chapterData: [],        // Holds data for EPUB chapters for virtualization.
            wpm: 300,               // Current words-per-minute setting.
            textSize: 100,          // Text size percentage.
            fontStyle: 'mono',      // Current font style.
            currentTheme: 'dark',   // Current color theme.
            isPlaying: false,       // Is the RSVP reader currently playing?
            rsvpTimeoutId: null,    // ID of the timeout for the RSVP loop.
            currentFileType: null,  // Type of the loaded file (e.g., 'epub', 'text').
            panels: {               // State of the collapsible side panels.
                settings: { isOpenDesktop: true, isOpenMobile: false, isUserCollapsedDesktop: false },
                context: { isOpenDesktop: true, isOpenMobile: false, isUserCollapsedDesktop: false }
            },
            isFullscreen: false,            // Is the app in fullscreen mode?
            fsControlsTimeoutId: null,      // Timeout for hiding controls in fullscreen.
            loadedFileName: null,           // Name of the currently loaded file.
            epubBook: null,                 // The loaded ePub.js book object.
            viewerObserver: null,           // IntersectionObserver for EPUB chapter loading.
            isUserScrolling: false,         // Flag to detect if user is scrolling the context view.
            scrollTimeoutId: null,          // Timeout to reset the user scrolling flag.
            isProgrammaticScroll: false,    // Flag to differentiate user scroll from code-driven scroll.
            isBionicTextEnabled: false,     // Is Bionic Text enabled?
            blockData: []           // Holds non-EPUB virtualized blocks metadata
        };

        // Configuration constants for default values and behavior.
        const Config = {
            DEFAULT_WPM: 300,
            DEFAULT_TEXT_SIZE: 100,
            DEFAULT_FONT_STYLE: 'mono',
            DEFAULT_THEME: 'dark',
            INACTIVITY_TIMEOUT_FS: 3000, // 3 seconds before hiding controls in fullscreen.
            BASE_DELAY_MS: () => (AppState.wpm > 0 ? 60000 / AppState.wpm : 200),
            PAUSE_MULTIPLIERS: { // How much longer to pause for certain punctuation.
                comma: 1.3,
                period: 2.2,
                paragraph: 3.5 
            },
            VIRTUAL_BLOCK_WORDS: 1500 // Words per block for non-EPUB virtualization
        };


        // --- DOM Element Caching ---
        
        // Caches frequently accessed DOM elements for better performance.
        const DOM = {
            html: document.documentElement, body: document.body, app: document.getElementById('app'),
            topBar: document.getElementById('topBar'), bottomBar: document.getElementById('bottomBar'),
            settingsToggleBtn: document.getElementById('settingsToggleBtn'), contextToggleBtn: document.getElementById('contextToggleBtn'),
            wpmSlider: document.getElementById('wpmSlider'), wpmPopup: document.getElementById('wpmPopup'), wpmValuePopup: document.getElementById('wpmValuePopup'),
            fullscreenRsvpWordContainer: document.getElementById('fullscreenRsvpWordContainer'), currentWordSpanFS: document.getElementById('currentWord'),
            settingsPanel: document.getElementById('settingsPanelContainer'), contextPanel: document.getElementById('contextPanelContainer'),
            textSizeSlider: document.getElementById('textSizeSlider'), textSizeValue: document.getElementById('textSizeValue'),
            fontStyleButtons: document.querySelectorAll('.font-btn'), themeSelector: document.getElementById('themeSelector'),
            bionicTextToggle: document.getElementById('bionicTextToggle'),
            fileDropArea: document.getElementById('fileDropArea'), fileInput: document.getElementById('fileInput'),
            rsvpDisplay: document.getElementById('rsvpDisplay'), normalWordSpan: document.getElementById('normalWordSpan'),
            messageArea: document.getElementById('messageArea'),
            restartBtn: document.getElementById('restartBtn'), prevBtn: document.getElementById('prevBtn'),
            playPauseBtn: document.getElementById('playPauseBtn'), playIcon: document.querySelector('.play-icon'), pauseIcon: document.querySelector('.pause-icon'),
            nextBtn: document.getElementById('nextBtn'), fullscreenBtn: document.getElementById('fullscreenBtn'),
            fullscreenEnterIcon: document.querySelector('.fullscreen-enter-icon'), fullscreenExitIcon: document.querySelector('.fullscreen-exit-icon'),
            viewerPlaceholder: document.getElementById('viewerPlaceholder'), viewerText: document.getElementById('viewerText'),
        };


        // --- UI Update and Utility Functions ---

        // Displays a message to the user (e.g., loading, error, success).
        const setMessage = (text, type = 'info', duration = 3000) => {
            if (!DOM.messageArea) return;
            DOM.messageArea.textContent = text;
            DOM.messageArea.className = 'message-area'; // Reset classes
            if (text) {
                DOM.messageArea.classList.add('visible', `${type}-message`);
                if (duration > 0) {
                    setTimeout(() => { if (DOM.messageArea.textContent === text) DOM.messageArea.classList.remove('visible'); }, duration);
                }
            } else {
                DOM.messageArea.classList.remove('visible');
            }
        };
        
        // A simple storage abstraction. Could be expanded to use localStorage.
        const Storage = { get: (k, d) => d, set: (k, v) => {} };
        
        // Updates the WPM slider's visual state and popup value.
        function updateWpmSliderDisplay() {
            const slider = DOM.wpmSlider; if (!slider) return;
            const perc = (AppState.wpm - parseInt(slider.min)) / (parseInt(slider.max) - parseInt(slider.min)) * 100;
            slider.style.setProperty('--slider-fill-percent', `${perc}%`);
            DOM.wpmValuePopup.textContent = AppState.wpm;
            const popup = DOM.wpmPopup;
            const thumbCenterPosition = ((slider.offsetWidth - 22) * (perc / 100)) + 11;
            popup.style.left = `${thumbCenterPosition}px`;
            popup.style.transform = `translateX(-50%)`;
        }

        // Updates the text size based on the slider value.
        function updateTextSizeDisplay() {
            if (DOM.textSizeSlider) {
                DOM.textSizeSlider.value = AppState.textSize;
                const min = parseInt(DOM.textSizeSlider.min), max = parseInt(DOM.textSizeSlider.max);
                DOM.textSizeSlider.style.setProperty('--slider-fill-percent', `${((AppState.textSize - min) / (max - min)) * 100}%`);
            }
            if (DOM.textSizeValue) DOM.textSizeValue.textContent = `${AppState.textSize}%`;
            const scale = AppState.textSize / 100;
            const baseSizeVar = window.innerWidth <= 768 ? '--rsvp-base-font-size-mobile' : '--rsvp-base-font-size-desktop';
            const baseFontSize = getComputedStyle(document.documentElement).getPropertyValue(baseSizeVar).trim();
            if (DOM.normalWordSpan) DOM.normalWordSpan.style.fontSize = `calc(${baseFontSize} * ${scale})`;
            if (DOM.currentWordSpanFS) DOM.currentWordSpanFS.style.fontSize = `calc(${getComputedStyle(document.documentElement).getPropertyValue('--rsvp-base-font-size-desktop').trim()} * 1.5 * ${scale})`;
        }

        // Updates the font style for the reader and context view.
        function updateFontStyleDisplay() {
            DOM.fontStyleButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.font === AppState.fontStyle));
            const fontVar = `var(--font-${AppState.fontStyle})`;
            if (DOM.normalWordSpan) DOM.normalWordSpan.style.fontFamily = fontVar;
            if (DOM.currentWordSpanFS) DOM.currentWordSpanFS.style.fontFamily = fontVar;
            if (DOM.viewerText) DOM.viewerText.style.fontFamily = fontVar;

            if (AppState.wordsOnly.length > 0) {
                highlightContextWord(AppState.currentItemIndex - 1);
            }
        }

        // Applies a new color theme to the application.
        let isApplyingTheme = false;
        function applyTheme(themeName) {
            if (isApplyingTheme || AppState.currentTheme === themeName) return;
            isApplyingTheme = true;
            DOM.html.classList.add('theme-switching');
            requestAnimationFrame(() => {
                AppState.currentTheme = themeName;
                DOM.html.className = `theme-${themeName}`;
                DOM.themeSelector.querySelectorAll('.theme-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === themeName));
                requestAnimationFrame(() => {
                    DOM.html.classList.remove('theme-switching');
                    isApplyingTheme = false;
                    if (AppState.wordsOnly.length > 0) {
                        highlightContextWord(AppState.currentItemIndex - 1);
                    }
                });
            });
        }

        // Toggles the play/pause icon and button title.
        function updatePlayPauseButton() {
            const isPlaying = AppState.isPlaying;
            DOM.playIcon.style.display = isPlaying ? 'none' : 'inline-block';
            DOM.pauseIcon.style.display = isPlaying ? 'inline-block' : 'none';
            DOM.playPauseBtn.title = isPlaying ? "Pause (Space)" : "Play (Space)";
        }

        // Toggles the fullscreen enter/exit icon.
        function updateFullscreenButton() {
            const isFullscreen = AppState.isFullscreen;
            DOM.fullscreenEnterIcon.style.display = isFullscreen ? 'none' : 'inline-block';
            DOM.fullscreenExitIcon.style.display = isFullscreen ? 'inline-block' : 'none';
            DOM.fullscreenBtn.title = isFullscreen ? "Exit Fullscreen (F)" : "Enter Fullscreen (F)";
        }

        // Updates the active state of the panel toggle buttons.
        function updatePanelToggleButtons() {
            const isMobile = window.innerWidth <= 768;
            const settingsOpen = isMobile ? DOM.settingsPanel.classList.contains('open') : !DOM.settingsPanel.classList.contains('collapsed');
            DOM.settingsToggleBtn.classList.toggle('active', settingsOpen);
            DOM.settingsToggleBtn.setAttribute('aria-expanded', settingsOpen);
            const contextOpen = isMobile ? DOM.contextPanel.classList.contains('open') : !DOM.contextPanel.classList.contains('collapsed');
            DOM.contextToggleBtn.classList.toggle('active', contextOpen);
            DOM.contextToggleBtn.setAttribute('aria-expanded', contextOpen);
        }

        // Enables or disables player controls based on whether content is loaded.
        function updatePlayerControlsState() {
            const hasContent = AppState.wordsOnly.length > 0;
            DOM.playPauseBtn.disabled = !hasContent;
            DOM.restartBtn.disabled = !hasContent;
            DOM.prevBtn.disabled = !hasContent || AppState.currentItemIndex === 0;
            DOM.nextBtn.disabled = !hasContent || AppState.currentItemIndex >= AppState.wordsOnly.length - 1;
        }

        // Functions for managing UI visibility in fullscreen mode.
        const showAppBars = () => { DOM.topBar.classList.add('controls-visible'); DOM.bottomBar.classList.add('controls-visible'); };
        const hideAppBars = () => { DOM.topBar.classList.remove('controls-visible'); DOM.bottomBar.classList.remove('controls-visible'); };
        const resetAppBarsTimeout = () => {
            clearTimeout(AppState.fsControlsTimeoutId);
            if (AppState.isFullscreen) AppState.fsControlsTimeoutId = setTimeout(hideAppBars, Config.INACTIVITY_TIMEOUT_FS);
        };

        // Resets the application to its initial state, clearing any loaded document.
        function resetUIState() {
            stopRSVP();
            if (AppState.viewerObserver) AppState.viewerObserver.disconnect();
            AppState.viewerObserver = null;
            AppState.epubBook = null;
            AppState.wordsOnly = [];
            AppState.pauseMap = {};
            AppState.chapterData = [];
            AppState.blockData = [];
            AppState.currentItemIndex = 0;
            AppState.currentFileType = null;
            AppState.loadedFileName = null;
            DOM.fileDropArea.classList.remove('hidden');
            DOM.rsvpDisplay.classList.remove('visible');
            DOM.normalWordSpan.innerHTML = 'Load a document to begin.';
            DOM.currentWordSpanFS.innerHTML = '';
            setMessage('');
            updatePlayerControlsState();
            DOM.viewerText.innerHTML = '';
            DOM.viewerPlaceholder.classList.add('active');
            DOM.viewerText.classList.remove('active');
        }


        // --- Panel Management ---

        // Toggles the visibility of side panels, adapting to mobile or desktop layout.
        function togglePanel(panelId) {
            const panelEl = document.getElementById(panelId); if (!panelEl) return;
            const isMobile = window.innerWidth <= 768;
            const panelStateKey = panelId === 'settingsPanelContainer' ? 'settings' : 'context';
            if (isMobile) { // On mobile, panels are overlays.
                const isOpen = !panelEl.classList.contains('open');
                panelEl.classList.toggle('open', isOpen);
                // Ensure only one mobile panel is open at a time.
                if (isOpen) (panelId === 'settingsPanelContainer' ? DOM.contextPanel : DOM.settingsPanel).classList.remove('open');
            } else { // On desktop, panels collapse/expand.
                const isCollapsed = !panelEl.classList.contains('collapsed');
                panelEl.classList.toggle('collapsed', isCollapsed);
                AppState.panels[panelStateKey].isUserCollapsedDesktop = isCollapsed;
            }
            updatePanelToggleButtons();
        }

        // Restores panel states on window resize (e.g., from mobile to desktop).
        function loadPanelStates() {
            if (window.innerWidth > 768) {
                DOM.settingsPanel.classList.toggle('collapsed', AppState.panels.settings.isUserCollapsedDesktop);
                DOM.contextPanel.classList.toggle('collapsed', AppState.panels.context.isUserCollapsedDesktop);
            }
            updatePanelToggleButtons();
        }


        // --- RSVP Core & Text Processing ---

        // Formats a word for Bionic Text display (bolded first part).
        function toBionicText(word) {
            if (!word || typeof word !== 'string') return '';
            const len = word.length;
            if (len === 0) return '';
            
            let boldCount;
            if (len <= 3) {
                boldCount = 1;
            } else if (len <= 5) {
                boldCount = 2;
            } else if (len <= 7) {
                boldCount = 3;
            } else {
                boldCount = Math.ceil(len * 0.4);
            }

            return `<span class="bionic-bold">${word.substring(0, boldCount)}</span><span class="bionic-normal">${word.substring(boldCount)}</span>`;
        }

        // Displays a word with the calculated fixation point highlighted.
        function displayWordWithFixation(wordText) {
            if (typeof wordText !== 'string' || wordText.trim() === '') {
                DOM.normalWordSpan.innerHTML = ''; DOM.currentWordSpanFS.innerHTML = ''; return;
            }
            const len = wordText.length;
            // Calculate fixation index: around 35% of the word length.
            let fixationIndex = Math.floor(len * 0.35);
            fixationIndex = Math.max(0, Math.min(fixationIndex, len - 1)); // Ensure it's a valid index.
            
            const content = `${wordText.substring(0, fixationIndex)}<span class="fixation-point">${wordText[fixationIndex]}</span>${wordText.substring(fixationIndex + 1)}`;
            DOM.normalWordSpan.innerHTML = content;
            DOM.currentWordSpanFS.innerHTML = content;
        }

        // The main RSVP loop. Displays a word, waits, and calls itself for the next word.
        async function displayCurrentItem() {
            if (!AppState.isPlaying || AppState.currentItemIndex >= AppState.wordsOnly.length) {
                stopRSVP();
                if (AppState.wordsOnly.length > 0) {
                    setMessage('End of document.', 'info', 3000);
                    await highlightContextWord(-1); // Unhighlight all words
                    displayWordWithFixation('END');
                }
                return;
            }

            const word = AppState.wordsOnly[AppState.currentItemIndex];
            let delay = Config.BASE_DELAY_MS();

            displayWordWithFixation(word);
            await highlightContextWord(AppState.currentItemIndex);

            // Apply pause multipliers for punctuation.
            const pauseMultiplier = AppState.pauseMap[AppState.currentItemIndex];
            if (pauseMultiplier) delay *= pauseMultiplier;

            AppState.currentItemIndex++;
            updatePlayerControlsState();

            // Schedule the next word.
            AppState.rsvpTimeoutId = setTimeout(displayCurrentItem, delay);
        }

        // Starts the RSVP reader.
        function startRSVP() {
            if (AppState.wordsOnly.length === 0) return;
            stopRSVP(); 
            AppState.isPlaying = true; 
            updatePlayPauseButton();
            // If at the end, restart from the beginning.
            if (AppState.currentItemIndex >= AppState.wordsOnly.length) AppState.currentItemIndex = 0;
            DOM.rsvpDisplay.classList.add('visible'); 
            DOM.fileDropArea.classList.add('hidden');
            displayCurrentItem();
        }

        // Stops the RSVP reader.
        function stopRSVP() {
            clearTimeout(AppState.rsvpTimeoutId); 
            AppState.rsvpTimeoutId = null;
            AppState.isPlaying = false; 
            updatePlayPauseButton();
        }

        // Processes a raw text string into an array of words and a punctuation pause map.
        function processText(text) {
            AppState.wordsOnly = []; 
            AppState.pauseMap = {}; 
            AppState.currentItemIndex = 0;

            const tokens = text.split(/(\s+)/); // Split by whitespace, keeping the whitespace.
            let wordIndexCounter = 0;

            tokens.forEach(token => {
                if (/\s+/.test(token)) {
                    // Detect paragraph breaks for longer pauses.
                    if (token.includes('\n\n') && wordIndexCounter > 0) {
                        AppState.pauseMap[wordIndexCounter - 1] = Config.PAUSE_MULTIPLIERS.paragraph;
                    }
                } else if (token) {
                    AppState.wordsOnly.push(token);
                    const lastChar = token.slice(-1);
                    if ('.?!'.includes(lastChar)) {
                        AppState.pauseMap[wordIndexCounter] = Config.PAUSE_MULTIPLIERS.period;
                    } else if (',;:'.includes(lastChar)) {
                        AppState.pauseMap[wordIndexCounter] = Config.PAUSE_MULTIPLIERS.comma;
                    }
                    wordIndexCounter++;
                }
            });

            if (AppState.wordsOnly.length > 0) {
                displayWordWithFixation(AppState.wordsOnly[0]);
            }
        }

        // Append a text fragment without creating a single giant string in memory
        function appendTextFragment(text, addParagraphBreakAfter = false) {
            if (!text || typeof text !== 'string') return;
            let wordIndexCounter = AppState.wordsOnly.length;
            const tokens = text.split(/(\s+)/);
            tokens.forEach(token => {
                if (/\s+/.test(token)) {
                    if (token.includes('\n\n') && wordIndexCounter > 0) {
                        AppState.pauseMap[wordIndexCounter - 1] = Config.PAUSE_MULTIPLIERS.paragraph;
                    }
                } else if (token) {
                    AppState.wordsOnly.push(token);
                    const lastChar = token.slice(-1);
                    if ('.?!'.includes(lastChar)) {
                        AppState.pauseMap[wordIndexCounter] = Config.PAUSE_MULTIPLIERS.period;
                    } else if (',;:'.includes(lastChar)) {
                        AppState.pauseMap[wordIndexCounter] = Config.PAUSE_MULTIPLIERS.comma;
                    }
                    wordIndexCounter++;
                }
            });
            if (addParagraphBreakAfter && AppState.wordsOnly.length > 0) {
                AppState.pauseMap[AppState.wordsOnly.length - 1] = Config.PAUSE_MULTIPLIERS.paragraph;
            }
        }


        // --- File Handling & Processing ---

        // Cleans HTML content from EPUB files, removing scripts, styles, and other non-textual elements.
        function cleanEpubHtml(htmlString) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlString, "text/html");
            const body = doc.body;

            body.querySelectorAll('script, style, link, img, image, svg, video, audio, [aria-hidden="true"], [hidden]').forEach(el => el.remove());
            body.querySelectorAll('[style*="display:none"], [style*="visibility:hidden"]').forEach(el => el.remove());
            
            const contentDiv = document.createElement('div');
            contentDiv.innerHTML = body.innerHTML;
            return contentDiv;
        }

        // Extracts content from a file based on its extension.
        async function extractContent(file) {
            const fileExt = file.name.split('.').pop().toLowerCase();
            
            if (fileExt === 'txt') {
                const text = await file.text();
                return { type: 'text', content: text };
            }
            
            if (fileExt === 'pdf') {
                if (!window.pdfjsLib) throw new Error("PDF.js library is not loaded.");
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                const parts = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();
                    parts.push(textContent.items.map(item => item.str).join(' '));
                }
                return { type: 'text', content: parts.join('\n\n') };
            }

            if (fileExt === 'epub') {
                if (!window.ePub || !window.JSZip) throw new Error("EPUB.js or JSZip is not loaded.");
                window.ePub.JSZip = window.JSZip; // Required by ePub.js
                const book = window.ePub(await file.arrayBuffer());
                await book.ready;
                return { type: 'epub', content: book };
            }

            if (fileExt === 'docx') {
                if (!window.mammoth) throw new Error("Mammoth.js library is not loaded.");
                const arrayBuffer = await file.arrayBuffer();
                const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer });
                return { type: 'text', content: result.value };
            }

            throw new Error('Unsupported file type.');
        }

        // Main function to handle file loading, processing, and UI updates.
        async function loadAndProcessFile(file) {
            if (!file) return;
            resetUIState();
            AppState.loadedFileName = file.name;
            setMessage(`Loading ${file.name}...`, 'loading', 0);

            try {
                const { type, content } = await extractContent(file);
                AppState.currentFileType = type;

                if (type === 'epub') {
                    AppState.epubBook = content;
                    let cumulativeWordIndex = 0;
                    const chapterTexts = [];
                    // Iterate through the EPUB's spine to process each chapter.
                    for (const item of AppState.epubBook.spine.spineItems) {
                        const section = await AppState.epubBook.section(item.index);
                        const sectionHtml = await section.render(AppState.epubBook.load.bind(AppState.epubBook));
                        const cleanedDiv = cleanEpubHtml(sectionHtml);
                        const text = cleanedDiv.textContent || "";
                        const wordCount = text.split(/\s+/).filter(Boolean).length;
                        
                        // Store chapter data for virtual rendering.
                        AppState.chapterData.push({ startWordIndex: cumulativeWordIndex, wordCount: wordCount, isRendered: false });
                        
                        chapterTexts.push(text);
                        cumulativeWordIndex += wordCount;
                    }
                    processText(chapterTexts.join('\n\n'));
                    chapterTexts.length = 0; // release
                } else { // For TXT, PDF, DOCX
                    AppState.epubBook = null;
                    processText(content);
                }

                if (AppState.wordsOnly.length === 0) {
                    throw new Error("No text could be extracted from the document.");
                }

                buildAndLoadContextViewer();
                if (AppState.wordsOnly.length > 0) {
                    highlightContextWord(0);
                }

                DOM.fileDropArea.classList.add('hidden');
                DOM.rsvpDisplay.classList.add('visible');
                setMessage(`Loaded: ${file.name}. Press Play.`, 'success');
                updatePlayerControlsState();

            } catch (error) {
                setMessage(`Error: ${error.message}`, 'error', 5000);
                resetUIState();
            } finally {
                DOM.fileInput.value = null; // Reset file input
            }
        }


        // --- Context Viewer, Virtualization & Highlighting ---

        // Finds the chapter index for a given global word index in an EPUB.
        function findChapterIndexForWord(wordIndex) {
            return AppState.chapterData.findIndex(c => wordIndex >= c.startWordIndex && wordIndex < c.startWordIndex + c.wordCount);
        }

        // Highlights the current word in the context viewer and scrolls it into view.
        async function highlightContextWord(wordIndex) {
            document.querySelectorAll('.context-word.highlight').forEach(el => el.classList.remove('highlight'));
            if (wordIndex < 0) return;

            let target;
            if (AppState.currentFileType === 'epub') {
                const chapterIndex = findChapterIndexForWord(wordIndex);
                if (chapterIndex === -1) return;

                // If the chapter isn't rendered yet, render it.
                if (!AppState.chapterData[chapterIndex].isRendered) {
                    await renderChapter(chapterIndex, true); 
                }
                const container = document.getElementById(`chapter-container-${chapterIndex}`);
                if (container) target = container.querySelector(`.context-word[data-word-index="${wordIndex}"]`);
            } else {
                const blockIndex = findBlockIndexForWord(wordIndex);
                if (blockIndex === -1) return;
                if (!AppState.blockData[blockIndex].isRendered) {
                    await renderBlock(blockIndex);
                }
                const container = document.getElementById(`block-container-${blockIndex}`);
                if (container) target = container.querySelector(`.context-word[data-word-index="${wordIndex}"]`);
            }

            if (target) {
                target.classList.add('highlight');
                // Programmatically scroll the highlighted word into the center of the view.
                if (!AppState.isUserScrolling) {
                    AppState.isProgrammaticScroll = true;
                    const targetRect = target.getBoundingClientRect();
                    const viewerRect = DOM.viewerText.getBoundingClientRect();
                    const desiredScrollTop = DOM.viewerText.scrollTop + targetRect.top - viewerRect.top - (viewerRect.height / 2) + (targetRect.height / 2);
                    DOM.viewerText.scrollTo({
                        top: desiredScrollTop,
                        behavior: 'auto'
                    });
                }
            }
        }
        
        // Unrenders an EPUB chapter that is no longer visible to save memory.
        function unrenderChapter(chapterIndex) {
            const chapterInfo = AppState.chapterData[chapterIndex];
            if (!chapterInfo || !chapterInfo.isRendered) return;

            const container = document.getElementById(`chapter-container-${chapterIndex}`);
            if (container) {
                container.innerHTML = `Loading Chapter ${chapterIndex + 1}...`;
                container.className = 'chapter-placeholder';
            }
            chapterInfo.isRendered = false;
        }

        function findBlockIndexForWord(wordIndex) {
            return AppState.blockData.findIndex(b => wordIndex >= b.startWordIndex && wordIndex < b.startWordIndex + b.wordCount);
        }

        function unrenderBlock(blockIndex) {
            const blockInfo = AppState.blockData[blockIndex];
            if (!blockInfo || !blockInfo.isRendered) return;
            const container = document.getElementById(`block-container-${blockIndex}`);
            if (container) {
                container.innerHTML = 'Loading...';
                container.className = 'chapter-placeholder';
            }
            blockInfo.isRendered = false;
        }

        async function renderBlock(blockIndex) {
            const blockInfo = AppState.blockData[blockIndex];
            if (!blockInfo || blockInfo.isRendered) return;
            const placeholder = document.getElementById(`block-container-${blockIndex}`);
            if (!placeholder) return;

            const start = blockInfo.startWordIndex;
            const end = Math.min(start + blockInfo.wordCount, AppState.wordsOnly.length);
            let html = '<p>';
            for (let i = start; i < end; i++) {
                const word = AppState.wordsOnly[i];
                const displayWord = AppState.isBionicTextEnabled ? toBionicText(word) : word;
                html += `<span class="context-word" data-word-index="${i}" tabindex="0">${displayWord}</span>`;
                if (AppState.pauseMap[i] === Config.PAUSE_MULTIPLIERS.paragraph) html += '</p><p>';
                else html += ' ';
            }
            html += '</p>';
            placeholder.innerHTML = html.replace(/<p><\/p>/g, '');
            placeholder.classList.remove('chapter-placeholder');
            
            placeholder.querySelectorAll('.context-word').forEach(el => {
                const jumpToWord = () => {
                    const wordIdx = parseInt(el.dataset.wordIndex, 10);
                    if (!isNaN(wordIdx) && wordIdx < AppState.wordsOnly.length) {
                        stopRSVP(); AppState.currentItemIndex = wordIdx;
                        displayWordWithFixation(AppState.wordsOnly[wordIdx]);
                        highlightContextWord(wordIdx); updatePlayerControlsState();
                    }
                };
                el.addEventListener('click', jumpToWord);
                el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToWord(); }});
            });
            blockInfo.isRendered = true;
        }

        // Renders an EPUB chapter into the DOM, wrapping words in spans for interaction.
        async function renderChapter(chapterIndex) {
            const chapterInfo = AppState.chapterData[chapterIndex];
            if (!AppState.epubBook || !chapterInfo || chapterInfo.isRendered) return;

            const placeholder = document.getElementById(`chapter-container-${chapterIndex}`);
            if (!placeholder) return;

            try {
                const item = AppState.epubBook.spine.spineItems[chapterIndex];
                const section = await AppState.epubBook.section(item.index);
                const sectionHtml = await section.render(AppState.epubBook.load.bind(AppState.epubBook));
                const cleanedDiv = cleanEpubHtml(sectionHtml);
                const contentDiv = document.createElement('div');
                contentDiv.innerHTML = cleanedDiv.innerHTML;
                
                // Use a TreeWalker to efficiently find all text nodes.
                let wordIndexCounter = chapterInfo.startWordIndex;
                const walker = document.createTreeWalker(contentDiv, NodeFilter.SHOW_TEXT);
                const nodesToProcess = [];
                let node;
                while(node = walker.nextNode()) { nodesToProcess.push(node); }

                // Replace text nodes with spans for each word.
                nodesToProcess.forEach(textNode => {
                    const words = textNode.textContent.split(/(\s+)/);
                    if (words.every(w => w.trim() === '')) return;
                    const fragment = document.createDocumentFragment();
                    words.forEach(word => {
                        if (word.trim().length > 0) {
                            const span = document.createElement('span');
                            span.className = 'context-word';
                            span.dataset.wordIndex = wordIndexCounter++;
                            span.innerHTML = AppState.isBionicTextEnabled ? toBionicText(word) : word;
                            fragment.appendChild(span);
                        } else {
                            fragment.appendChild(document.createTextNode(word));
                        }
                    });
                    textNode.parentNode.replaceChild(fragment, textNode);
                });
                
                placeholder.innerHTML = '';
                placeholder.appendChild(contentDiv);
                placeholder.classList.remove('chapter-placeholder');
                
                // Add event listeners to the new word spans.
                placeholder.querySelectorAll('.context-word').forEach(el => {
                    const jumpToWord = () => {
                        const wordIdx = parseInt(el.dataset.wordIndex, 10);
                        if (!isNaN(wordIdx) && wordIdx < AppState.wordsOnly.length) {
                            stopRSVP(); AppState.currentItemIndex = wordIdx;
                            displayWordWithFixation(AppState.wordsOnly[wordIdx]);
                            highlightContextWord(wordIdx); updatePlayerControlsState();
                        }
                    };
                    el.addEventListener('click', jumpToWord);
                    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToWord(); }});
                });

                // Prevent links within the EPUB from navigating away.
                placeholder.querySelectorAll('a').forEach(a => {
                    a.addEventListener('click', e => e.preventDefault());
                });

                chapterInfo.isRendered = true;
                // Release temporary DOM references for GC
                // cleanedDiv and walker variables go out of scope; no persistent HTML stored
            } catch (error) {
                placeholder.textContent = `Error loading chapter.`;
            }
        }

        // Builds the entire context viewer, setting up virtualization for EPUBs.
        function buildAndLoadContextViewer() {
            DOM.viewerText.innerHTML = '';
            
            if (AppState.currentFileType === 'epub') {
                // Create placeholders for each chapter.
                AppState.chapterData.forEach((_, index) => {
                    const placeholder = document.createElement('div');
                    placeholder.id = `chapter-container-${index}`;
                    placeholder.className = 'chapter-placeholder';
                    placeholder.dataset.chapterIndex = index;
                    placeholder.textContent = `Chapter ${index + 1}`;
                    DOM.viewerText.appendChild(placeholder);
                });

                // Set up IntersectionObserver to render/unrender chapters as they scroll into/out of view.
                AppState.viewerObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        const chapterIndex = parseInt(entry.target.dataset.chapterIndex, 10);
                        if (entry.isIntersecting) {
                            renderChapter(chapterIndex);
                        } else {
                            unrenderChapter(chapterIndex);
                        }
                    });
                }, { root: DOM.viewerText, rootMargin: '1000px 0px' }); // Load content 1000px before it's visible.

                document.querySelectorAll('.chapter-placeholder').forEach(el => AppState.viewerObserver.observe(el));

            } else { // For non-EPUB files, virtualize by blocks
                AppState.blockData = [];
                const totalWords = AppState.wordsOnly.length;
                const blockSize = Config.VIRTUAL_BLOCK_WORDS;
                for (let start = 0, blockIndex = 0; start < totalWords; start += blockSize, blockIndex++) {
                    const count = Math.min(blockSize, totalWords - start);
                    AppState.blockData.push({ startWordIndex: start, wordCount: count, isRendered: false });
                    const placeholder = document.createElement('div');
                    placeholder.id = `block-container-${blockIndex}`;
                    placeholder.className = 'chapter-placeholder';
                    placeholder.dataset.blockIndex = blockIndex;
                    placeholder.textContent = `Loading...`;
                    DOM.viewerText.appendChild(placeholder);
                }

                AppState.viewerObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        const blockIndex = parseInt(entry.target.dataset.blockIndex, 10);
                        if (entry.isIntersecting) {
                            renderBlock(blockIndex);
                        } else {
                            unrenderBlock(blockIndex);
                        }
                    });
                }, { root: DOM.viewerText, rootMargin: '1000px 0px' });

                document.querySelectorAll('[data-block-index]').forEach(el => AppState.viewerObserver.observe(el));
            }

            DOM.viewerPlaceholder.classList.remove('active');
            DOM.viewerText.classList.add('active');
        }


        // --- Event Handlers & Initialization ---

        // Applies or removes Bionic Text formatting from the context view.
        function toggleBionicText(isEnabled) {
            AppState.isBionicTextEnabled = isEnabled;
            
            document.querySelectorAll('.context-word').forEach(span => {
                if (span.querySelector('a')) { return; }
                const wordIndex = parseInt(span.dataset.wordIndex, 10);
                const word = AppState.wordsOnly[wordIndex];
                span.innerHTML = isEnabled ? toBionicText(word) : word;
            });
            
            const currentWord = AppState.wordsOnly[AppState.currentItemIndex - 1];
            if (currentWord) {
                displayWordWithFixation(currentWord);
            }
        }

        // Handles changes to the browser's fullscreen state.
        function handleFullscreenChange() {
            AppState.isFullscreen = !!document.fullscreenElement;
            DOM.app.classList.toggle('fullscreen-active', AppState.isFullscreen);
            updateFullscreenButton();
            clearTimeout(AppState.fsControlsTimeoutId);

            if (AppState.isFullscreen) {
                hideAppBars();
                document.addEventListener('mousemove', resetAppBarsTimeout);
                document.addEventListener('touchstart', resetAppBarsTimeout);
            } else {
                showAppBars();
                document.removeEventListener('mousemove', resetAppBarsTimeout);
                document.removeEventListener('touchstart', resetAppBarsTimeout);
            }
        }

        // Handles global keyboard shortcuts.
        function handleGlobalKeyDown(e) {
            // Ignore key presses if an input or panel content is focused.
            if (e.target.closest('input, button, .panel-content')) return;
            
            e.preventDefault();
            switch (e.key) {
                case ' ': DOM.playPauseBtn.click(); break;
                case 'ArrowLeft': DOM.prevBtn.click(); break;
                case 'ArrowRight': DOM.nextBtn.click(); break;
                case 'Home': DOM.restartBtn.click(); break;
                case 'f': case 'F': DOM.fullscreenBtn.click(); break;
                case 's': case 'S': DOM.settingsToggleBtn.click(); break;
                case 'd': case 'D': DOM.contextToggleBtn.click(); break;
                case 'Escape': if (AppState.isFullscreen) document.exitFullscreen(); break;
            }
        }
        
        // Binds all necessary event listeners for the application.
        function bindEventListeners() {
            // Panel toggles
            DOM.settingsToggleBtn.addEventListener('click', () => togglePanel('settingsPanelContainer'));
            DOM.contextToggleBtn.addEventListener('click', () => togglePanel('contextPanelContainer'));

            // Settings controls
            DOM.wpmSlider.addEventListener('input', e => { AppState.wpm = parseInt(e.target.value, 10); DOM.wpmPopup.classList.add('visible'); updateWpmSliderDisplay(); });
            DOM.wpmSlider.addEventListener('change', e => { AppState.wpm = parseInt(e.target.value, 10); if (AppState.isPlaying) { stopRSVP(); startRSVP(); } DOM.wpmPopup.classList.remove('visible'); });
            DOM.textSizeSlider.addEventListener('input', e => { AppState.textSize = parseInt(e.target.value, 10); updateTextSizeDisplay(); });
            DOM.fontStyleButtons.forEach(btn => btn.addEventListener('click', e => { AppState.fontStyle = e.currentTarget.dataset.font; updateFontStyleDisplay(); }));
            DOM.themeSelector.addEventListener('click', e => { const btn = e.target.closest('.theme-btn'); if(btn) applyTheme(btn.dataset.theme); });
            DOM.bionicTextToggle.addEventListener('change', e => toggleBionicText(e.target.checked));
            
            // File input and drag-and-drop
            DOM.fileInput.addEventListener('change', e => loadAndProcessFile(e.target.files[0]));
            DOM.fileDropArea.addEventListener('dragover', e => { e.preventDefault(); DOM.fileDropArea.classList.add('drag-over'); });
            DOM.fileDropArea.addEventListener('dragleave', () => DOM.fileDropArea.classList.remove('drag-over'));
            DOM.fileDropArea.addEventListener('drop', e => { e.preventDefault(); DOM.fileDropArea.classList.remove('drag-over'); if(e.dataTransfer.files[0]) loadAndProcessFile(e.dataTransfer.files[0]); });
            
            // Player controls
            DOM.restartBtn.addEventListener('click', () => { AppState.currentItemIndex = 0; stopRSVP(); if(AppState.wordsOnly.length>0){ displayWordWithFixation(AppState.wordsOnly[0]); highlightContextWord(0); } updatePlayerControlsState(); });
            DOM.prevBtn.addEventListener('click', () => {
                if (AppState.currentItemIndex <= 1) { DOM.restartBtn.click(); return; }
                stopRSVP(); AppState.currentItemIndex = Math.max(0, AppState.currentItemIndex - 2);
                const word = AppState.wordsOnly[AppState.currentItemIndex];
                if (word) { displayWordWithFixation(word); highlightContextWord(AppState.currentItemIndex); }
                updatePlayerControlsState();
            });
            DOM.playPauseBtn.addEventListener('click', () => AppState.isPlaying ? stopRSVP() : startRSVP());
            DOM.nextBtn.addEventListener('click', () => {
                if (AppState.currentItemIndex >= AppState.wordsOnly.length - 1) return;
                stopRSVP();
                const word = AppState.wordsOnly[AppState.currentItemIndex];
                if (word) { displayWordWithFixation(word); highlightContextWord(AppState.currentItemIndex); }
                AppState.currentItemIndex++; updatePlayerControlsState();
            });

            // Fullscreen and global events
            DOM.fullscreenBtn.addEventListener('click', () => AppState.isFullscreen ? document.exitFullscreen() : DOM.app.requestFullscreen());
            document.addEventListener('fullscreenchange', handleFullscreenChange);
            document.addEventListener('keydown', handleGlobalKeyDown);
            window.addEventListener('resize', () => { loadPanelStates(); updateWpmSliderDisplay(); updateTextSizeDisplay(); });

            // Context viewer scroll handling
            DOM.viewerText.addEventListener('scroll', () => {
                if (AppState.isProgrammaticScroll) {
                    AppState.isProgrammaticScroll = false; return;
                }
                if (!AppState.isPlaying) return;
                AppState.isUserScrolling = true;
                clearTimeout(AppState.scrollTimeoutId);
                AppState.scrollTimeoutId = setTimeout(() => {
                    AppState.isUserScrolling = false;
                    highlightContextWord(AppState.currentItemIndex - 1);
                }, 5000);
            });
        }
        
        // Initializes the application on page load.
        function initApp() {
            // Attempt to clear any persistent storage from previous sessions.
            try { 
                localStorage.clear(); 
                sessionStorage.clear();
                document.cookie.split(';').forEach(c => {
                    const name = c.split('=')[0].trim();
                    if (name) document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
                });
            } catch (e) {
                // Storage might be disabled (e.g., in private browsing).
            }
            
            // Load settings or use defaults.
            AppState.wpm = Storage.get('wpm', Config.DEFAULT_WPM); DOM.wpmSlider.value = AppState.wpm;
            AppState.textSize = Storage.get('textSize', Config.DEFAULT_TEXT_SIZE);
            AppState.fontStyle = Storage.get('fontStyle', Config.DEFAULT_FONT_STYLE);
            
            // Initialize UI elements and bind event listeners.
            applyTheme(Storage.get('theme', Config.DEFAULT_THEME));
            updateWpmSliderDisplay(); 
            updateTextSizeDisplay(); 
            updateFontStyleDisplay();
            loadPanelStates(); 
            bindEventListeners(); 
            resetUIState();
        }

        // Start the application.
        initApp();

    });
    