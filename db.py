import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
import os

load_dotenv()  # loads .env file automatically

DB_CONFIG = {
    'host':     'aws-1-ap-northeast-1.pooler.supabase.com',  # note: aws-1 not aws-0
    'port':      5432,  # note: 5432 not 6543
    'dbname':   'postgres',
    'user':     'postgres.zdjedicrwyikxynnptvk',
    'password': os.getenv('SUPABASE_PASSWORD')
}

def get_db():
    return psycopg2.connect(**DB_CONFIG)

def get_cursor(conn):
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)