FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /chamber-agenda && chown 65534:65534 /chamber-agenda
WORKDIR /app
COPY scripts/parliament-house-agenda.py scripts/parliament-senate-agenda.py ./scripts/
COPY scripts/lib/html_tree.py scripts/lib/parliament_intake.py ./scripts/lib/
COPY services/weekly-archive/runtime.py ./services/weekly-archive/
COPY services/institution-coverage/container/snapshot.py ./services/institution-coverage/container/
COPY services/chamber-agenda/run.py ./services/chamber-agenda/
RUN python3 -B scripts/parliament-house-agenda.py --help >/dev/null \
    && python3 -B scripts/parliament-senate-agenda.py --help >/dev/null \
    && python3 -B services/chamber-agenda/run.py --help >/dev/null
USER 65534:65534
EXPOSE 8080
CMD ["python3", "-B", "/app/services/chamber-agenda/run.py"]
