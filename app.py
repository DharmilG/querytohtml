from flask import Flask, render_template, request, jsonify
from googlesearch import search
import page_saver as html_saver
import time
import os
from datetime import datetime

app = Flask(__name__, template_folder='templates')

@app.route('/')
def index():
    return render_template('front.html')

@app.route('/search', methods=['POST'])
def handle_search():
    data = request.get_json()
    query = data.get('query')
    num_results = data.get('num_results', 10)

    if not query:
        return jsonify({'error': 'Query is missing'}), 400

    safe_query = "".join(c for c in query if c.isalnum() or c in (' ', '.', '_')).rstrip()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    search_folder_name = f"{safe_query[:50].replace(' ', '_')}_{timestamp}"

    try:
        print(f"Searching Google for: '{query}'")
        search_results = list(search(query, num_results=num_results, sleep_interval=2, advanced=True))
        
        processed_info = []
        
        print(f"Found {len(search_results)} results. Now saving HTML content to '{search_folder_name}'...")

        for result in search_results:
            url = result.url
            print(f"Processing URL: {url}")
            filename, success = html_saver.process_url(url, search_folder_name)
            processed_info.append({
                'url': url,
                'filename': filename,
                'success': success
            })
            time.sleep(1)

        return jsonify({
            'message': f'Processing complete. Files saved in folder: {search_folder_name}',
            'folder_name': search_folder_name,
            'results': processed_info
        })

    except Exception as e:
        print(f"An error occurred during search or processing: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
