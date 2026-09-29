/*
 * Non-production fractional clock-rate benchmark: Relay's distributed
 * one-sample/frame linear trim vs an independent SpeexDSP resampler.
 *
 * Deliberately uses the documented public Speex API, not AudioSession.
 * The real Relay estimator, sample-address authority, gaps, generation
 * changes and calibration are NOT simulated by this microbenchmark.
 *
 * Build on Debian/Ubuntu:
 *   sudo apt-get install -y build-essential pkg-config libspeexdsp-dev
 *   cc -O2 -Wall -Wextra -Werror -std=c11 \
 *      scripts/speex-clock-probe.c -o /tmp/speex-clock-probe \
 *      $(pkg-config --cflags --libs speexdsp) -lm
 *   /tmp/speex-clock-probe 30 > /tmp/speex-clock-report.json
 */
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <speex/speex_resampler.h>

#define RATE 48000
#define FRAME 960
#define CAPACITY (FRAME * 4)
#define PI 3.14159265358979323846

static double ms_since(struct timespec a, struct timespec b) {
    return (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1000000.0;
}

static double ideal_signal(double source_position) {
    const double t = source_position / RATE;
    return 5500.0 * sin(2.0 * PI * 220.0 * t)
         + 3500.0 * sin(2.0 * PI * 1980.0 * t);
}

static spx_int16_t synth(int64_t index) {
    const double t = (double)index / RATE;
    (void)t;
    const double x = ideal_signal((double)index);
    return (spx_int16_t)lround(x);
}

static spx_int16_t linear_sample(spx_int16_t a, spx_int16_t b, double fraction) {
    return (spx_int16_t)lround((double)a + ((double)b - a) * fraction);
}

static void run_case(int seconds, int ppm, int first) {
    int err = RESAMPLER_ERR_SUCCESS;
    SpeexResamplerState *resampler = speex_resampler_init(
        1, RATE, RATE, SPEEX_RESAMPLER_QUALITY_DESKTOP, &err);
    if (!resampler || err != RESAMPLER_ERR_SUCCESS) {
        fprintf(stderr, "speex init failed: %s\n", speex_resampler_strerror(err));
        exit(1);
    }

    // The ratio is input_rate / output_rate. A slow 48k capture at +50 ppm
    // should emit 1.00005 output samples per source sample, continuously.
    const spx_uint32_t ratio_num = 1000000;
    const spx_uint32_t ratio_den = (spx_uint32_t)(1000000 + ppm);
    const spx_uint32_t reported_output_rate =
        (spx_uint32_t)lround((double)RATE * ratio_den / ratio_num);
    err = speex_resampler_set_rate_frac(
        resampler, ratio_num, ratio_den, RATE, reported_output_rate);
    if (err != RESAMPLER_ERR_SUCCESS) {
        fprintf(stderr, "speex ratio failed: %s\n", speex_resampler_strerror(err));
        exit(1);
    }
    spx_uint32_t actual_num = 0, actual_den = 0;
    speex_resampler_get_ratio(resampler, &actual_num, &actual_den);
    if (fabs((double)actual_num / actual_den - (double)ratio_num / ratio_den) > 1e-12) {
        fprintf(stderr, "fractional ratio was not retained\n");
        exit(1);
    }

    const int frame_count = seconds * 50;
    const int64_t total_input = (int64_t)frame_count * FRAME;
    spx_int16_t input[FRAME];
    spx_int16_t output[CAPACITY];
    int64_t speex_samples = 0;
    int64_t relay_samples = 0;
    int corrected_frames = 0;
    uint64_t relay_energy = 0, speex_energy = 0;
    double relay_ideal_err2 = 0, speex_ideal_err2 = 0;
    uint64_t relay_ideal_n = 0, speex_ideal_n = 0;
    const int fixed_speex_latency = speex_resampler_get_output_latency(resampler);
    const double source_per_output = (double)ratio_num / ratio_den;
    double carry = 0;
    double speex_boundary_step = 0;
    double relay_boundary_step = 0;
    spx_int16_t last_speex = 0, last_relay = 0;
    int have_speex = 0, have_relay = 0;
    double cpu_speex_ms = 0, cpu_relay_ms = 0;

    for (int frame = 0; frame < frame_count; ++frame) {
        for (int i = 0; i < FRAME; i++) input[i] = synth((int64_t)frame * FRAME + i);
        struct timespec a, b;

        clock_gettime(CLOCK_MONOTONIC, &a);
        spx_uint32_t consumed = 0;
        while (consumed < FRAME) {
            spx_uint32_t in_len = (spx_uint32_t)(FRAME - consumed);
            spx_uint32_t out_len = CAPACITY;
            err = speex_resampler_process_int(
                resampler, 0, input + consumed, &in_len, output, &out_len);
            if (err != RESAMPLER_ERR_SUCCESS || (in_len == 0 && out_len == 0)) {
                fprintf(stderr, "speex process stalled: %s\n", speex_resampler_strerror(err));
                exit(1);
            }
            if (have_speex && out_len > 0) {
                const double step = fabs((double)output[0] - last_speex);
                if (step > speex_boundary_step) speex_boundary_step = step;
            }
            for (spx_uint32_t i = 0; i < out_len; ++i) {
                const int64_t v = output[i];
                speex_energy += (uint64_t)(v * v);
                const int64_t j = speex_samples + i;
                // Account for the filter's reported group delay. Skip cold
                // start, where its initial padding is intentionally audible.
                if (j >= RATE / 10) {
                    const double ideal = ideal_signal((j - fixed_speex_latency) * source_per_output);
                    const double error = output[i] - ideal;
                    speex_ideal_err2 += error * error;
                    speex_ideal_n++;
                }
            }
            if (out_len > 0) { last_speex = output[out_len - 1]; have_speex = 1; }
            speex_samples += out_len;
            consumed += in_len;
        }
        clock_gettime(CLOCK_MONOTONIC, &b);
        cpu_speex_ms += ms_since(a, b);

        // Same span-distributed +/-1 algorithm as Relay's trim primitive,
        // including preserved endpoints. This is a standalone execution
        // comparison, NOT a substitute for full AudioSession A/B output.
        clock_gettime(CLOCK_MONOTONIC, &a);
        carry += (FRAME * (double)ppm) / 1000000.0;
        int delta = carry >= 1.0 ? 1 : carry <= -1.0 ? -1 : 0;
        if (delta != 0) { carry -= delta; corrected_frames++; }
        int out_len = FRAME + delta;
        spx_int16_t first_sample = 0, last_sample = 0;
        for (int i = 0; i < out_len; i++) {
            const double position = ((double)i * (FRAME - 1)) / (out_len - 1);
            const int left = (int)floor(position);
            const double fraction = position - left;
            const spx_int16_t sample = linear_sample(input[left], input[left < FRAME - 1 ? left + 1 : left], fraction);
            const int64_t v = sample;
            relay_energy += (uint64_t)(v * v);
            const int64_t j = relay_samples + i;
            if (j >= RATE / 10) {
                const double ideal = ideal_signal(j * source_per_output);
                const double error = sample - ideal;
                relay_ideal_err2 += error * error;
                relay_ideal_n++;
            }
            if (i == 0) first_sample = sample;
            if (i == out_len - 1) last_sample = sample;
        }
        if (have_relay) {
            const double step = fabs((double)first_sample - last_relay);
            if (step > relay_boundary_step) relay_boundary_step = step;
        }
        last_relay = last_sample;
        have_relay = 1;
        relay_samples += out_len;
        clock_gettime(CLOCK_MONOTONIC, &b);
        cpu_relay_ms += ms_since(a, b);
    }

    const int in_latency = speex_resampler_get_input_latency(resampler);
    const int out_latency = speex_resampler_get_output_latency(resampler);
    const double expected_output = (double)total_input * ratio_den / ratio_num;
    // The fractional count may differ by filter delay and less than one
    // frame of streaming quantisation; any larger error invalidates the probe.
    if (fabs(speex_samples + out_latency - expected_output) > FRAME) {
        fprintf(stderr, "unexpected speex output count at %d ppm\n", ppm);
        exit(1);
    }

    printf("%s{\"ppm\":%d,\"sourceSamples\":%lld,\"expectedOutput\":%.2f,"
           "\"relaySamples\":%lld,\"relayCorrectedFrames\":%d,"
           "\"speexSamples\":%lld,\"speexInputLatency\":%d,"
           "\"speexOutputLatency\":%d,\"relayBoundaryStep\":%.0f,"
           "\"speexBoundaryStep\":%.0f,\"relayEnergy\":%llu,\"speexEnergy\":%llu,"
           "\"relayIdealRms\":%.4f,\"speexIdealRms\":%.4f,\"relayCpuMs\":%.4f,\"speexCpuMs\":%.4f}",
           first ? "" : ",",
           ppm, (long long)total_input, expected_output, (long long)relay_samples,
           corrected_frames, (long long)speex_samples, in_latency, out_latency,
           relay_boundary_step, speex_boundary_step, (unsigned long long)relay_energy, (unsigned long long)speex_energy,
           sqrt(relay_ideal_err2 / relay_ideal_n), sqrt(speex_ideal_err2 / speex_ideal_n),
           cpu_relay_ms, cpu_speex_ms);
    speex_resampler_destroy(resampler);
}

int main(int argc, char **argv) {
    const int seconds = argc > 1 ? atoi(argv[1]) : 30;
    if (seconds < 1 || seconds > 120) {
        fprintf(stderr, "duration must be 1..120 seconds\n");
        return 2;
    }
    printf("{\"seconds\":%d,\"sampleRate\":%d,\"cases\":[", seconds, RATE);
    const int cases[] = { 0, 50, -50, 100, -100 };
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        run_case(seconds, cases[i], i == 0);
    }
    printf("],\"limits\":[\"No packet gaps, capture generation changes, calibration or authoritative time mapping\","
           "\"CPU times are host-only and are not mobile AudioWorklet deadlines\","
           "\"Boundary steps are diagnostic, not perceptual quality measurements\"]}\n");
    return 0;
}
