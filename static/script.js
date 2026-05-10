// ── API endpoint ──
const API = '';
let COLAB_API = '';  // set automatically when Colab starts
let currentUser = JSON.parse(localStorage.getItem('mm_user') || 'null');

function isValidEmail(email) {
    // Must have @, a real domain, and a TLD of at least 2 real characters
    const re = /^[^\s@]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;
    if (!re.test(email)) return false;
    // Block obviously fake TLDs (single letters like .D, .c etc)
    const tld = email.split('.').pop();
    if (tld.length < 2) return false;
    return true;
}

// ── state ──
let currentScreen     = 'home';
let historyItems      = [];
let uploadedAudioFile = null;
let uploadedFileId    = null;

// ── Audio format whitelist ──
const AUDIO_EXTS = [
    'wav','mp3','m4a','aac','ogg','flac','opus','wma','webm','mp4','aiff','aif','caf'
];
function isAudioFile(file) {
    if (!file) return false;
    const ext = file.name.split('.').pop().toLowerCase();
    return AUDIO_EXTS.includes(ext) || file.type.startsWith('audio/');
}

// ── Toast notification (replaces alert() for non-blocking messages) ──
function showToast(msg) {
    let toast = document.getElementById('mm-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mm-toast';
        toast.style.cssText = `
            position:fixed; bottom:32px; left:50%; transform:translateX(-50%);
            background:var(--accent); color:#fff; padding:12px 24px;
            border-radius:24px; font-size:0.9rem; font-weight:500;
            z-index:9999; box-shadow:0 4px 16px rgba(0,0,0,0.2);
            opacity:0; transition:opacity 0.3s; pointer-events:none;
        `;
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

// ── Receive Colab URL from server ──
async function fetchColabUrl() {
    try {
        const res  = await fetch(`${API}/get-colab-url`);
        const data = await res.json();
        if (data.colab_api) {
            COLAB_API = data.colab_api;
            console.log('Colab API set to:', COLAB_API);
        }
    } catch (e) {
        console.warn('Could not fetch Colab URL:', e);
    }
}

// ── Hint bubbles ──
function showHint(id) {
    document.querySelectorAll('.hint-bubble').forEach(b => b.classList.add('hidden'));
    document.getElementById(id)?.classList.remove('hidden');
}
function hideAllHints() {
    document.querySelectorAll('.hint-bubble').forEach(b => b.classList.add('hidden'));
}

// ===== AUTH =====
function initAuth() {
    const overlay       = document.getElementById('login-overlay');
    const loginWrapper  = document.getElementById('login-form-wrapper');
    const regWrapper    = document.getElementById('register-form-wrapper');
    const loginError    = document.getElementById('login-error');
    const registerError = document.getElementById('register-error');

    if (currentUser) {
        overlay.style.display = 'none';
        return;
    }

    document.getElementById('go-register').addEventListener('click', () => {
        loginWrapper.style.display = 'none';
        regWrapper.style.display   = 'flex';
        loginError.classList.remove('visible');
    });

    document.getElementById('go-login').addEventListener('click', () => {
        regWrapper.style.display   = 'none';
        loginWrapper.style.display = 'flex';
        registerError.classList.remove('visible');
    });

    // register
    document.getElementById('register-btn').addEventListener('click', async () => {
        const name     = document.getElementById('reg-name').value.trim();
        const email    = document.getElementById('reg-email').value.trim();
        const password = document.getElementById('reg-password').value;

        if (!name || !email || !password) {
            registerError.textContent = 'All fields required.';
            registerError.classList.add('visible');
            return;
        }

        if (!isValidEmail(email)) {
            registerError.textContent = 'Enter a valid email address.';
            registerError.classList.add('visible');
            return;
        }

        const passwordRegex = /^(?=.*[A-Z])(?=.*\d).{6,}$/;
        if (!passwordRegex.test(password)) {
            registerError.textContent =
                'Password must be 6+ characters, with at least 1 uppercase letter and 1 number.';
            registerError.classList.add('visible');
            return;
        }

        try {
            const res  = await fetch(`${API}/register`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ name, email, password })
            });
            const data = await res.json();
            if (!data.success) {
                registerError.textContent = data.message;
                registerError.classList.add('visible');
                return;
            }
            // Store email so Profile screen can display it
            currentUser = { id: data.user_id, name: data.name, email };
            localStorage.setItem('mm_user', JSON.stringify(currentUser));
            overlay.style.display = 'none';
        } catch {
            registerError.textContent = 'Server error. Is Flask running?';
            registerError.classList.add('visible');
        }
    });

    // login
    document.getElementById('login-btn').addEventListener('click', async () => {
        const email    = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        // ── Client-side validation ──
        if (!email || !password) {
            loginError.textContent = 'Please enter your email and password.';
            loginError.classList.add('visible');
            return;
        }
        if (!isValidEmail(email)) {
            loginError.textContent = 'Please enter a valid email address.';
            loginError.classList.add('visible');
            return;
        }

        try {
            const res  = await fetch(`${API}/login`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!data.success) {
                // Use the server's specific error message (e.g. "Email not found" vs "Wrong password")
                loginError.textContent = data.message || 'Invalid email or password.';
                loginError.classList.add('visible');
                return;
            }
            loginError.classList.remove('visible');
            // Store email so Profile screen can display it
            currentUser = { id: data.user_id, name: data.name, email };
            localStorage.setItem('mm_user', JSON.stringify(currentUser));
            overlay.style.display = 'none';
        } catch {
            loginError.textContent = 'Server error. Is Flask running?';
            loginError.classList.add('visible');
        }
    });

    // Enter key support
    document.getElementById('login-password')
        .addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); });
    document.getElementById('reg-password')
        .addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('register-btn').click(); });
}

// ===== SCREEN =====
function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.toggle('hidden', s.id !== name + '-screen');
    });
    document.querySelectorAll('.nav-btn[data-screen]').forEach(b => {
        b.classList.toggle('active', b.dataset.screen === name);
    });
    document.querySelectorAll('.top-tabs .tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.step === name);
    });
    const flowScreens = ['record', 'details', 'generate'];
    document.getElementById('flow-tabs').classList.toggle('hidden-tabs', !flowScreens.includes(name));
    currentScreen = name;
}

// ===== HISTORY =====
function updateHistoryView() {
    const container = document.getElementById('history-content');
    container.innerHTML = '';

    if (historyItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.innerHTML = `
            <p>History is empty. Start your first meeting in one click.</p>
            <button id="start-now" class="primary-btn">Start Now</button>
        `;
        container.appendChild(empty);
        document.getElementById('start-now').addEventListener('click', () => showScreen('record'));
    } else {
        const table = document.createElement('table');
        table.className = 'history-list';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Title</th>
                    <th>Created At</th>
                    <th>Type</th>
                    <th>PDF</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        historyItems.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${item.title}</td>
                <td>${item.created}</td>
                <td>${item.type}</td>
                <td>${item.pdf
                    ? `<a href="${item.pdf}" target="_blank" style="color:var(--accent)">View PDF</a>`
                    : '—'
                }</td>
                <td><button class="icon-btn">&#128065;</button></td>
            `;
            table.querySelector('tbody').appendChild(tr);
        });
        container.appendChild(table);
    }
}

// ===== THEME =====
function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode');
}

// ===== TRANSCRIPT =====
function setTranscript(text) {
    const el = document.getElementById('transcript-content');
    if (!el) return;

    // Remove example styling once real content arrives
    el.classList.remove('example-transcript');
    el.removeAttribute('title');

    if (!text) {
        el.innerHTML = '<p style="color:var(--secondary)">Transcript will appear here after processing…</p>';
        return;
    }

    // Format "Speaker: text" lines with bold speaker name
    const lines = text.split('\n').filter(l => l.trim());
    el.innerHTML = lines.map(line => {
        const match = line.match(/^([^:]+):\s*(.+)/);
        if (match) return `<p><strong>${match[1]}:</strong> ${match[2]}</p>`;
        return `<p>${line}</p>`;
    }).join('');
}

// ===== PDF DOWNLOAD =====
function triggerPdfDownload(pdfLink, title) {
    const safeName = (title || 'meeting-minutes').replace(/[^a-z0-9_\-]/gi, '_');
    const a = document.createElement('a');
    a.href     = `${API}/download-pdf?path=${encodeURIComponent(pdfLink)}`;
    a.download = `${safeName}_minutes.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ===== EVENTS =====
function setupEvents() {

    // ── sidebar nav ──
    document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
        btn.addEventListener('click', () => showScreen(btn.dataset.screen));
    });

    document.getElementById('start-btn').addEventListener('click', () => showScreen('record'));
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // ── top tabs ──
    document.querySelectorAll('.top-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => showScreen(tab.dataset.step));
    });

    // ── file upload ──
    const uploadArea = document.getElementById('upload-area');
    const fileInput  = document.getElementById('file-input');

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragging');
    });
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragging');
    });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragging');
        const file = e.dataTransfer.files[0];
        if (file) {
            fileInput.files = e.dataTransfer.files;
            document.getElementById('upload-btn').textContent = file.name;
            uploadedAudioFile = file;
            showHint('record-hint');   // speech bubble pointing to Next
        }
    });

    document.getElementById('upload-btn').addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            document.getElementById('upload-btn').textContent = file.name;
            uploadedAudioFile = file;
            showHint('record-hint');   // speech bubble pointing to Next
        }
    });

    // ── profile screen load ──
    document.querySelector('[data-screen="profile"]').addEventListener('click', () => {
        const user = JSON.parse(localStorage.getItem('mm_user'));
        if (user) {
            document.getElementById('profile-name').value  = user.name  || '';
            document.getElementById('profile-email').value = user.email || '';
        }
    });

    // ── next from record → validate format, then upload audio to Flask ──
    document.getElementById('next-from-record')?.addEventListener('click', async () => {

        // 1. File selected?
        if (!uploadedAudioFile) {
            showToast('Please select an audio file first.');
            return;
        }

        // 2. Audio format validation — show error on Next click
        if (!isAudioFile(uploadedAudioFile)) {
            showToast('Only audio files are accepted. Please upload a .wav, .mp3, .m4a or similar audio file.');
            return;
        }

        hideAllHints();

        // 3. Upload to server
        const btn = document.getElementById('next-from-record');
        btn.disabled    = true;
        btn.textContent = 'Uploading…';

        try {
            if (!COLAB_API) {
                showToast('Colab is not connected yet. Please start Colab first.');
                btn.disabled    = false;
                btn.textContent = 'Next';
                return;
            }

            const formData = new FormData();
            formData.append('audio', uploadedAudioFile);

            // Upload directly to Colab — bypasses laptop upload speed limit
            const res  = await fetch(`${COLAB_API}/upload-audio`, {
                method: 'POST',
                body:   formData
            });
            const data = await res.json();

            if (data.success) {
                uploadedFileId = data.file_id;  // Colab local path e.g. /content/audio.wav
                showScreen('details');
            } else {
                showToast(data.message || 'Upload failed. Please try again.');
            }
        } catch (err) {
            console.error('Audio upload failed:', err);
            showToast('Upload failed. Is Colab running?');
        } finally {
            btn.disabled    = false;
            btn.textContent = 'Next';
        }
    });

    // ── details form: show hint bubble when all required fields are filled ──
    const requiredFields = document.querySelectorAll('#details-form [required]');
    function checkDetailsComplete() {
        const allFilled = [...requiredFields].every(f => f.value.trim() !== '');
        if (allFilled) showHint('details-hint');
        else hideAllHints();
    }
    requiredFields.forEach(f => f.addEventListener('input', checkDetailsComplete));

    // ── next from details → validate required fields ──
    document.getElementById('next-from-details').addEventListener('click', () => {
        const requiredIds = [
            'meeting-title',
            'meeting-datetime',
            'attendees',
            'roles',
            'note-taker',
            'location-type',
            'end-time'
        ];

        let valid = true;
        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el.value.trim()) {
                el.style.borderColor = 'red';
                valid = false;
            } else {
                el.style.borderColor = '';
            }
        });

        if (!valid) {
            showToast('Please fill in all required fields.');
            return;
        }

        hideAllHints();
        setTranscript('');   // clear placeholder before generate screen
        showScreen('generate');
    });

    // ── copy transcript ──
    document.getElementById('copy-transcript')?.addEventListener('click', () => {
        const text = document.getElementById('transcript-content')?.innerText || '';
        navigator.clipboard.writeText(text)
            .then(()  => showToast('Transcript copied to clipboard!'))
            .catch(()  => showToast('Could not copy — try selecting the text manually.'));
    });

    // ── generate meeting minutes ──
    document.getElementById('generate-btn').addEventListener('click', async () => {
        const btn = document.getElementById('generate-btn');
        btn.disabled    = true;
        btn.textContent = 'Sending…';

        const reset = () => {
            btn.disabled    = false;
            btn.textContent = 'Generate M.M';
        };

        if (!uploadedFileId) {
            showToast('Please upload audio first.');
            reset();
            return;
        }

        const meetingData = {
            user_id:          currentUser?.id,
            file_id:          uploadedFileId,
            title:            document.getElementById('meeting-title').value || 'Untitled',
            meeting_datetime: document.getElementById('meeting-datetime').value,
            attendees:        document.getElementById('attendees').value,
            roles:            document.getElementById('roles').value,
            facilitator:      document.getElementById('facilitator').value,
            note_taker:       document.getElementById('note-taker').value,
            meeting_mode:     document.getElementById('location-type').value,
            end_time:         document.getElementById('end-time').value,
            notes:            document.getElementById('notes').value
        };

        try {
            // Step 1: Submit meeting — returns instantly with meeting_id
            const res  = await fetch(`${API}/save-meeting`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(meetingData)
            });
            const data = await res.json();

            if (!data.success) {
                showToast(data.message || data.error || 'Submission failed. Please try again.');
                reset();
                return;
            }

            const meetingId = data.meeting_id;

            // Step 2: Show processing state — Colab is working in background
            btn.textContent = 'Processing…';
            showToast('Your meeting is being processed. This may take a few minutes ☕');

            // Step 3: Poll /meeting-status every 5 seconds until done or error
            const pollInterval = 5000;
            const maxWaitMs    = 90 * 60 * 1000;  // 90 minutes max
            const startTime    = Date.now();

            const messages = [
                'Transcribing audio…',
                'Identifying speakers…',
                'Extracting key points…',
                'Writing meeting minutes…',
                'Almost there…'
            ];
            let msgIndex = 0;
            const msgTimer = setInterval(() => {
                btn.textContent = messages[Math.min(msgIndex, messages.length - 1)];
                msgIndex++;
            }, 120000);  // rotate message every 30s

            const poll = async () => {
                if (Date.now() - startTime > maxWaitMs) {
                    clearInterval(msgTimer);
                    reset();
                    showToast('Processing is taking longer than expected. Check History in a few minutes — it will appear there when done.');
                    return;
                }

                try {
                    const statusRes  = await fetch(`${API}/meeting-status/${meetingId}`);
                    const statusData = await statusRes.json();

                    if (statusData.status === 'done') {
                        clearInterval(msgTimer);
                        reset();

                        // Show transcript
                        setTranscript(statusData.transcript || '');

                        // Auto-download PDF
                        if (statusData.pdf_link) {
                            triggerPdfDownload(statusData.pdf_link, meetingData.title);
                        }

                        // Add to history
                        historyItems.unshift({
                            title:   meetingData.title,
                            created: new Date().toLocaleString(),
                            type:    'Minutes',
                            pdf:     statusData.pdf_link
                                ? `${API}/download-pdf?path=${encodeURIComponent(statusData.pdf_link)}`
                                : null
                        });
                        updateHistoryView();
                        showScreen('success');

                    } else if (statusData.status === 'error') {
                        clearInterval(msgTimer);
                        reset();
                        showToast(statusData.message || 'Generation failed. Please try again.');

                    } else {
                        // Still processing — check again in 5s
                        setTimeout(poll, pollInterval);
                    }

                } catch (err) {
                    console.error('Polling error:', err);
                    setTimeout(poll, pollInterval);  // retry on network hiccup
                }
            };

            setTimeout(poll, pollInterval);  // first check after 5s

        } catch (err) {
            reset();
            console.error(err);
            showToast('Server error. Is Flask running?');
        }
    });

    // ── success screen buttons ──
    document.getElementById('home-from-success')?.addEventListener('click', () => showScreen('home'));
    document.getElementById('another-from-success')?.addEventListener('click', () => {
        // Reset flow for a fresh meeting
        uploadedAudioFile = null;
        uploadedFileId    = null;
        document.getElementById('upload-btn').textContent = 'Upload Audio';
        const fi = document.getElementById('file-input');
        if (fi) fi.value = '';
        document.getElementById('details-form')?.reset();
        setTranscript('');
        hideAllHints();
        showScreen('record');
    });

    // ── logout ──
    document.getElementById('logout-btn')?.addEventListener('click', () => {
        localStorage.removeItem('mm_user');
        currentUser = null;
        location.reload();
    });
}

// ===== INIT =====
window.addEventListener('DOMContentLoaded', () => {
    initAuth();
    setupEvents();
    updateHistoryView();
    showScreen('home');
    fetchColabUrl();  // grab Colab URL from webapp on load
});