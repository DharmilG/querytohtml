import requests
import re
from urllib.parse import urlparse
from pathlib import Path
import hashlib
import os

def get_raw_html(url):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        return response.text
    except requests.exceptions.RequestException as e:
        print(f"Error fetching URL {url}: {e}")
        return None

def save_to_file(filepath, content):
    try:
        output_directory = Path(filepath).parent
        output_directory.mkdir(parents=True, exist_ok=True)
        Path(filepath).write_text(content, encoding="utf-8")
        print(f"Content successfully saved to {filepath}")
        return True
    except IOError as e:
        print(f"Error saving to file {filepath}: {e}")
        return False

def generate_filename_from_url(url, output_directory="."):
    try:
        parsed_url = urlparse(url)
        domain = parsed_url.netloc or "unknown_domain"
        safe_domain = re.sub(r'[^\w.-]', '_', domain)
        url_hash = hashlib.md5(url.encode()).hexdigest()[:8]
        filename = f"{safe_domain}_{url_hash}.html"
        full_filepath = os.path.join(output_directory, filename)
        return full_filepath
    except Exception as e:
        print(f"Warning: Could not generate a clean filename from URL. Error: {e}")
        return os.path.join(output_directory, "webpage_content.html")

def process_url(url, output_directory="."):
    raw_html = get_raw_html(url)
    if raw_html:
        output_filepath = generate_filename_from_url(url, output_directory)
        if save_to_file(output_filepath, raw_html):
            return os.path.basename(output_filepath), True
        else:
            return os.path.basename(output_filepath), False
    return None, False

if __name__ == "__main__":
    test_folder = "test_scrapes"
    while True:
        user_url = input("Enter the URL of the website to scrape (or 'exit' to quit): ").strip()
        if user_url.lower() == 'exit':
            break
        if not user_url.startswith(('http://', 'https://')):
            print("Invalid URL. Please ensure it starts with 'http://' or 'https://'.")
            continue
        filename, success = process_url(user_url, test_folder)
        if success:
            print(f"Successfully saved content to {test_folder}/{filename}")
        else:
            print("Failed to retrieve HTML content. Please check the URL and your internet connection.")
