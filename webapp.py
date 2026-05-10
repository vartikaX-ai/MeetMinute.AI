from flask import Flask, render_template, request, jsonify, send_file
from flask_cors import CORS
from db import get_db, get_cursor
from dotenv import load_dotenv
import bcrypt
import requests as http_requests
import os
import json
import uuid
import base64
import threading

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', 'fallback_secret')
CORS(app)

COLAB_API = 'https://whale-omissions-tribe-questions.trycloudflare.com'

# ─── PAGE ──────────────────────────────────────────────────────

@app.route('/')
def home():
    return render_template('index.html')

# ─── UPDATE COLAB URL ──────────────────────────────────────────

@app.route('/update-colab-url', methods=['POST'])
def update_colab_url():
    global COLAB_API
    data      = request.get_json()
    COLAB_API = data.get('url', '').strip()
    print(f"\n✅ Colab URL updated to: {COLAB_API}\n")
    return jsonify({'success': True, 'colab_api': COLAB_API})

# ─── GET COLAB URL (frontend fetches this on page load) ────────

@app.route('/get-colab-url', methods=['GET'])
def get_colab_url():
    return jsonify({'colab_api': COLAB_API})

# ─── AUTH ──────────────────────────────────────────────────────

@app.route('/register', methods=['POST'])
def register():
    data     = request.get_json()
    name     = data.get('name', '').strip()
    email    = data.get('email', '').strip()
    password = data.get('password', '')

    if not name or not email or not password:
        return jsonify({'success': False, 'message': 'All fields required'}), 400
    if len(password) < 6:
        return jsonify({'success': False, 'message': 'Password min 6 characters'}), 400

    hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
    try:
        conn   = get_db()
        cursor = get_cursor(conn)
        cursor.execute('SELECT id FROM users WHERE email = %s', (email,))
        if cursor.fetchone():
            cursor.close(); conn.close()
            return jsonify({'success': False, 'message': 'Email already registered'}), 409
        cursor.execute(
            'INSERT INTO users (name, email, password) VALUES (%s, %s, %s) RETURNING id',
            (name, email, hashed.decode('utf-8'))
        )
        user_id = cursor.fetchone()['id']
        conn.commit(); cursor.close(); conn.close()
        return jsonify({'success': True, 'user_id': user_id, 'name': name})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/login', methods=['POST'])
def login():
    data     = request.get_json()
    email    = data.get('email', '').strip()
    password = data.get('password', '')
    try:
        conn   = get_db()
        cursor = get_cursor(conn)
        cursor.execute('SELECT * FROM users WHERE email = %s', (email,))
        user = cursor.fetchone()
        cursor.close(); conn.close()
        if not user:
            return jsonify({'success': False, 'message': 'Email not found'}), 401
        if not bcrypt.checkpw(password.encode('utf-8'), user['password'].encode('utf-8')):
            return jsonify({'success': False, 'message': 'Wrong password'}), 401
        return jsonify({'success': True, 'user_id': user['id'], 'name': user['name']})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/upload-audio', methods=['POST'])
def upload_audio():
    try:
        file = request.files.get('audio')
        if not file:
            return jsonify({'success': False, 'message': 'No file received'})
        filename  = f"{uuid.uuid4()}_{file.filename}"
        save_path = os.path.join('uploads', filename)
        os.makedirs('uploads', exist_ok=True)
        file.save(save_path)
        return jsonify({'success': True, 'file_id': save_path})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})


@app.route('/download-pdf', methods=['GET'])
def download_pdf():
    path        = request.args.get('path', '').strip()
    uploads_dir = os.path.abspath('uploads')
    abs_path    = os.path.abspath(path)
    if not abs_path.startswith(uploads_dir):
        return jsonify({'success': False, 'message': 'Forbidden'}), 403
    if not os.path.isfile(abs_path):
        return jsonify({'success': False, 'message': 'File not found'}), 404
    return send_file(abs_path, mimetype='application/pdf', as_attachment=True,
                     download_name=os.path.basename(abs_path))

# ─── BACKGROUND COLAB WORKER ───────────────────────────────────

def _run_colab(meeting_id, colab_filename, meeting_details, colab_url):
    """
    Runs in a background thread — totally invisible to the browser.
    1. Tells Colab to start processing — Colab returns instantly with a job_id
    2. Polls Colab /job-status/<job_id> every 15s until done
    3. Saves PDF + transcript to DB when complete
    """
    import time
    try:
        print(f"\n⏳ Background: starting Colab for meeting {meeting_id}\n")

        # Step 1: Kick off pipeline on Colab — returns in < 1 second
        start_resp = http_requests.post(
            f'{colab_url}/process-meeting',
            json={
                "audio_filename":  colab_filename,
                "meeting_details": meeting_details
            },
            timeout=(30, 30)
        )

        if start_resp.status_code != 200:
            raise RuntimeError(f"Colab /process-meeting returned HTTP {start_resp.status_code}")

        start_data = start_resp.json()
        if not start_data.get("success"):
            raise RuntimeError(start_data.get("error", "Colab failed to start job"))

        job_id = start_data["job_id"]
        print(f"⏳ Colab job started: {job_id}")

        # Step 2: Poll /job-status every 15 seconds (max 30 min)
        max_wait = 120 * 60  # 2 hours — enough for very long audio
        elapsed  = 0
        while elapsed < max_wait:
            time.sleep(15)
            elapsed += 15

            status_resp = http_requests.get(
                f'{colab_url}/job-status/{job_id}',
                timeout=(10, 10)
            )
            if status_resp.status_code != 200:
                print(f"Poll error: HTTP {status_resp.status_code} — retrying")
                continue

            job = status_resp.json()
            state = job.get("status")

            if state == "done":
                transcript = job.get("transcript", "")
                pdf_base64 = job.get("pdf_base64")
                if not pdf_base64:
                    raise RuntimeError("Job done but pdf_base64 missing")

                # Save PDF to disk
                os.makedirs('uploads', exist_ok=True)
                pdf_bytes    = base64.b64decode(pdf_base64)
                pdf_filename = f"meeting_{meeting_id}.pdf"
                pdf_path     = os.path.join("uploads", pdf_filename)
                with open(pdf_path, "wb") as pdf_file:
                    pdf_file.write(pdf_bytes)

                # Mark done in DB
                conn   = get_db()
                cursor = get_cursor(conn)
                cursor.execute(
                    "UPDATE meetings SET pdf_path=%s, transcript=%s, status='done' WHERE id=%s",
                    (pdf_path, transcript, meeting_id)
                )
                conn.commit(); cursor.close(); conn.close()
                print(f"\n✅ Background: meeting {meeting_id} done!\n")
                return

            elif state == "error":
                raise RuntimeError(f"Colab pipeline error: {job.get('error', 'unknown')}")

            else:
                print(f"⏳ Job {job_id} still processing... ({elapsed}s elapsed)")

        raise RuntimeError("Colab job timed out after 30 minutes")

    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            conn   = get_db()
            cursor = get_cursor(conn)
            cursor.execute(
                "UPDATE meetings SET status='error', error_message=%s WHERE id=%s",
                (str(e), meeting_id)
            )
            conn.commit(); cursor.close(); conn.close()
        except Exception:
            pass

# ─── MEETINGS ──────────────────────────────────────────────────

@app.route('/save-meeting', methods=['POST'])
def save_meeting():
    def empty_to_none(val):
        return None if val == '' or val is None else val

    data = request.get_json()

    if not data.get("file_id"):
        return jsonify({'success': False, 'message': 'Audio file missing — upload audio first'}), 400
    if not COLAB_API:
        return jsonify({'success': False, 'message': 'Colab is not connected yet.'}), 503

    try:
        # 1. Save to DB immediately with status = 'processing'
        conn   = get_db()
        cursor = get_cursor(conn)
        cursor.execute('''
            INSERT INTO meetings
              (user_id, title, meeting_datetime, attendees, roles,
               facilitator, note_taker, meeting_mode, end_time, notes, status)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'processing')
            RETURNING id
        ''', (
            data.get('user_id'),
            data.get('title'),
            empty_to_none(data.get('meeting_datetime')),
            data.get('attendees'),
            data.get('roles'),
            data.get('facilitator'),
            data.get('note_taker'),
            data.get('meeting_mode'),
            empty_to_none(data.get('end_time')),
            data.get('notes')
        ))
        meeting_id = cursor.fetchone()['id']
        conn.commit(); cursor.close(); conn.close()

        # 2. Kick off Colab in background — browser is NOT blocked
        meeting_details = {
            "title":            data.get("title"),
            "meeting_datetime": data.get("meeting_datetime"),
            "meeting_mode":     data.get("meeting_mode"),
            "facilitator":      data.get("facilitator"),
            "note_taker":       data.get("note_taker"),
            "attendees":        data.get("attendees"),
            "roles":            data.get("roles"),
            "end_time":         data.get("end_time"),
            "notes":            data.get("notes")
        }
        # file_id is now the Colab local path e.g. /content/uuid_audio.wav
        # We just pass the filename — Colab already has the file
        colab_filename = data.get("file_id")

        threading.Thread(
            target=_run_colab,
            args=(meeting_id, colab_filename, meeting_details, COLAB_API),
            daemon=True
        ).start()

        # 3. Return immediately — frontend will poll /meeting-status/<id>
        return jsonify({
            'success':    True,
            'status':     'processing',
            'meeting_id': meeting_id
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/meeting-status/<int:meeting_id>', methods=['GET'])
def meeting_status(meeting_id):
    """Frontend polls this every 5 seconds. Just reads the DB — returns instantly."""
    try:
        conn   = get_db()
        cursor = get_cursor(conn)
        cursor.execute(
            'SELECT status, pdf_path, transcript, error_message FROM meetings WHERE id=%s',
            (meeting_id,)
        )
        row = cursor.fetchone()
        cursor.close(); conn.close()

        if not row:
            return jsonify({'success': False, 'message': 'Meeting not found'}), 404

        status = row['status']

        if status == 'done':
            return jsonify({
                'success':    True,
                'status':     'done',
                'pdf_link':   row['pdf_path'],
                'transcript': row['transcript']
            })
        elif status == 'error':
            return jsonify({
                'success': False,
                'status':  'error',
                'message': row['error_message'] or 'Processing failed'
            })
        else:
            return jsonify({'success': True, 'status': 'processing'})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/meetings/<int:user_id>', methods=['GET'])
def get_meetings(user_id):
    try:
        conn   = get_db()
        cursor = get_cursor(conn)
        cursor.execute(
            'SELECT * FROM meetings WHERE user_id=%s ORDER BY created_at DESC',
            (user_id,)
        )
        meetings = cursor.fetchall()
        cursor.close(); conn.close()

        result = []
        for m in meetings:
            m = dict(m)
            for key, val in m.items():
                if hasattr(val, 'isoformat'):
                    m[key] = str(val)
            result.append(m)

        return jsonify({'success': True, 'meetings': result})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


if __name__ == '__main__':
    from waitress import serve
    print("\n🚀 Starting server on http://127.0.0.1:5000\n")
    serve(app, host='0.0.0.0', port=5000, threads=8)