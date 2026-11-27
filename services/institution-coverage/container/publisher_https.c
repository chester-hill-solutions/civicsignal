#include <curl/curl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

/* Run a single HTTPS transfer. The caller checks the destination of every redirect. */
int main(int argc, char **argv)
{
    if (argc != 6) {
        fprintf(stderr, "Expected URL, output path, byte limit, user agent and Accept header.\n");
        return CURLE_BAD_FUNCTION_ARGUMENT;
    }
    char *end;
    errno = 0;
    long limit = strtol(argv[3], &end, 10);
    if (errno || *end || limit <= 0) {
        fprintf(stderr, "Invalid response byte limit.\n");
        return CURLE_BAD_FUNCTION_ARGUMENT;
    }
    FILE *body = fopen(argv[2], "wb");
    if (!body) {
        perror("Cannot open response file");
        return CURLE_WRITE_ERROR;
    }
    CURLcode result = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (result != CURLE_OK) {
        fclose(body);
        fprintf(stderr, "%s\n", curl_easy_strerror(result));
        return result;
    }
    CURL *transfer = curl_easy_init();
    struct curl_slist *headers = curl_slist_append(NULL, argv[5]);
    char error[CURL_ERROR_SIZE] = {0};
    if (!transfer || !headers) {
        result = CURLE_OUT_OF_MEMORY;
        goto done;
    }

#define SET(option, value) do {                                           \
    result = curl_easy_setopt(transfer, option, value);                    \
    if (result != CURLE_OK) goto done;                                     \
} while (0)
    SET(CURLOPT_ERRORBUFFER, error);
    SET(CURLOPT_URL, argv[1]);
    SET(CURLOPT_PROTOCOLS_STR, "https");
    SET(CURLOPT_IPRESOLVE, (long)CURL_IPRESOLVE_V4);
    SET(CURLOPT_FOLLOWLOCATION, 0L);
    SET(CURLOPT_TIMEOUT, 30L);
    SET(CURLOPT_CONNECTTIMEOUT, 10L);
    SET(CURLOPT_MAXFILESIZE_LARGE, (curl_off_t)limit);
    SET(CURLOPT_CAINFO, "/usr/local/share/civicsignal-publisher-ca.pem");
    SET(CURLOPT_SSL_VERIFYPEER, 1L);
    SET(CURLOPT_SSL_VERIFYHOST, 2L);
    SET(CURLOPT_SSL_OPTIONS, (long)CURLSSLOPT_NO_PARTIALCHAIN);
    SET(CURLOPT_USERAGENT, argv[4]);
    SET(CURLOPT_HTTPHEADER, headers);
    SET(CURLOPT_WRITEDATA, body);
#undef SET

    result = curl_easy_perform(transfer);
    if (result == CURLE_OK) {
        long status;
        char *type = NULL;
        char *redirect = NULL;
        result = curl_easy_getinfo(transfer, CURLINFO_RESPONSE_CODE, &status);
        if (result == CURLE_OK) result = curl_easy_getinfo(transfer, CURLINFO_CONTENT_TYPE, &type);
        if (result == CURLE_OK) result = curl_easy_getinfo(transfer, CURLINFO_REDIRECT_URL, &redirect);
        if (result == CURLE_OK) {
            printf("%ld\n%s\n%s", status, type ? type : "", redirect ? redirect : "");
        }
    }
done:
    if (fclose(body) != 0 && result == CURLE_OK) result = CURLE_WRITE_ERROR;
    if (transfer) curl_easy_cleanup(transfer);
    curl_slist_free_all(headers);
    curl_global_cleanup();
    if (result != CURLE_OK) fprintf(stderr, "%s\n", error[0] ? error : curl_easy_strerror(result));
    return result;
}
