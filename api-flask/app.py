
import os

from flask import Flask, jsonify, request
import mysql.connector
from datetime import datetime

app = Flask(__name__)

# Kredensial MySQL dibaca dari environment, jangan ditulis di kode (repo ini public).
# Contoh (PowerShell): $env:MYSQL_PASSWORD = "password_mysql"
DB_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "localhost"),
    "user": os.environ.get("MYSQL_USER", "root"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
    "database": os.environ.get("MYSQL_DATABASE", "iot_binus")
}


def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)


@app.route("/")
def home():
    return jsonify({
        "status": "success",
        "message": "Flask IoT Server berjalan"
    })


@app.route("/test-db")
def test_db():
    conn = None

    try:
        conn = get_db_connection()

        return jsonify({
            "status": "success",
            "message": "Koneksi MySQL berhasil",
            "database": conn.database
        })

    except mysql.connector.Error:
        app.logger.exception("Koneksi MySQL gagal")

        return jsonify({
            "status": "error",
            "message": "Koneksi MySQL gagal"
        }), 500

    finally:
        if conn is not None and conn.is_connected():
            conn.close()


@app.route("/api/data", methods=["POST"])
def receive_data():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "status": "error",
            "message": "Data JSON tidak valid"
        }), 400

    required_fields = [
        "suhu",
        "kelembapan",
        "kipas",
        "gerakan",
        "nilai_asap",
        "asap"
    ]

    missing_fields = [
        field for field in required_fields
        if field not in data
    ]

    if missing_fields:
        return jsonify({
            "status": "error",
            "message": "Field data belum lengkap",
            "missing_fields": missing_fields
        }), 400

    try:
        suhu = float(data["suhu"])
        kelembapan = float(data["kelembapan"])
        kipas = int(data["kipas"])
        gerakan = int(data["gerakan"])
        nilai_asap = int(data["nilai_asap"])
        asap = int(data["asap"])

        if not 0 <= kelembapan <= 100:
            raise ValueError("Kelembapan tidak valid")

        if kipas not in (0, 1):
            raise ValueError("Status kipas harus 0 atau 1")

        if gerakan not in (0, 1):
            raise ValueError("Status gerakan harus 0 atau 1")

        if asap not in (0, 1):
            raise ValueError("Status asap harus 0 atau 1")

        if not 0 <= nilai_asap <= 4095:
            raise ValueError("Nilai analog MQ-2 tidak valid")

    except (ValueError, TypeError, KeyError):
        return jsonify({
            "status": "error",
            "message": "Format atau nilai data tidak valid"
        }), 400

    conn = None
    cursor = None

    try:
        conn = get_db_connection()
        conn.autocommit = False
        cursor = conn.cursor()

        now = datetime.now()

        # 1. Simpan data DHT22 dan status kipas
        cursor.execute(
            """
            INSERT INTO dht
                (suhu, kelembapan, status, create_date)
            VALUES (%s, %s, %s, %s)
            """,
            (str(suhu), str(kelembapan), kipas, now)
        )

        dht_id = cursor.lastrowid

        # 2. Simpan data PIR
        cursor.execute(
            """
            INSERT INTO pir (status, create_date)
            VALUES (%s, %s)
            """,
            (gerakan, now)
        )

        pir_id = cursor.lastrowid

        # Log untuk debugging PIR
        print(
            f"PIR INSERT ID: {pir_id} | Status: {gerakan}",
            flush=True
        )

        # 3. Simpan status MQ-2
        cursor.execute(
            """
            INSERT INTO mq (status, create_date)
            VALUES (%s, %s)
            """,
            (asap, now)
        )

        mq_id = cursor.lastrowid

        # Simpan ketiga insert sekaligus
        conn.commit()

        print(
            f"BERHASIL COMMIT | DHT ID: {dht_id} | "
            f"PIR ID: {pir_id} | MQ ID: {mq_id}",
            flush=True
        )

        return jsonify({
            "status": "success",
            "message": "Semua data sensor berhasil disimpan",
            "data": {
                "dht_id": dht_id,
                "pir_id": pir_id,
                "mq_id": mq_id,
                "suhu": suhu,
                "kelembapan": kelembapan,
                "kipas": kipas,
                "gerakan": gerakan,
                "nilai_asap": nilai_asap,
                "status_asap": asap
            }
        }), 201

    except mysql.connector.Error:
        if conn is not None:
            conn.rollback()

        app.logger.exception(
            "Gagal menyimpan data sensor ke MySQL"
        )

        return jsonify({
            "status": "error",
            "message": "Gagal menyimpan data ke database"
        }), 500

    except Exception:
        if conn is not None:
            conn.rollback()

        app.logger.exception("Terjadi kesalahan pada server")

        return jsonify({
            "status": "error",
            "message": "Terjadi kesalahan pada server"
        }), 500

    finally:
        if cursor is not None:
            cursor.close()

        if conn is not None and conn.is_connected():
            conn.close()


if __name__ == "__main__":
    # Debugger Flask bisa menjalankan kode dari jaringan; aktifkan hanya saat
    # pengembangan dengan FLASK_DEBUG=1.
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=os.environ.get("FLASK_DEBUG") == "1"
    )
