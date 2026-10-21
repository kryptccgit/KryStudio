// Minimal C ABI over the header-only Signalsmith Stretch library (MIT,
// vendored under ../vendor with its LICENSE files). Planar float buffers,
// no C++ exception ever crosses the boundary (every entry point catches and
// returns -1), and a fixed-seed std::mt19937 so renders are deterministic.

#include <signalsmith-stretch/signalsmith-stretch.h>

#include <new>
#include <random>

using Stretch = signalsmith::stretch::SignalsmithStretch<float, std::mt19937>;

struct kss_handle {
    Stretch s;
    explicit kss_handle(long seed) : s(seed) {}
};

extern "C" {

kss_handle *kss_create(int channels, int block_samples, int interval_samples, int split_computation, long seed) {
    if (channels < 1 || block_samples < 16 || interval_samples < 1 || interval_samples > block_samples) return nullptr;
    try {
        kss_handle *h = new kss_handle(seed);
        h->s.configure(channels, block_samples, interval_samples, split_computation != 0);
        return h;
    } catch (...) {
        return nullptr;
    }
}

void kss_destroy(kss_handle *h) {
    delete h;
}

int kss_block_samples(const kss_handle *h) { return h->s.blockSamples(); }
int kss_interval_samples(const kss_handle *h) { return h->s.intervalSamples(); }
int kss_input_latency(const kss_handle *h) { return h->s.inputLatency(); }
int kss_output_latency(const kss_handle *h) { return h->s.outputLatency(); }

int kss_set_transpose_semitones(kss_handle *h, float semitones, float tonality_limit) {
    try {
        h->s.setTransposeSemitones(semitones, tonality_limit);
        return 0;
    } catch (...) {
        return -1;
    }
}

int kss_set_formant(kss_handle *h, float factor, int compensate_pitch, float base_freq) {
    try {
        h->s.setFormantFactor(factor, compensate_pitch != 0);
        h->s.setFormantBase(base_freq);
        return 0;
    } catch (...) {
        return -1;
    }
}

int kss_seek(kss_handle *h, const float *const *input, int input_samples, double playback_rate) {
    try {
        h->s.seek(input, input_samples, playback_rate);
        return 0;
    } catch (...) {
        return -1;
    }
}

int kss_process(kss_handle *h, const float *const *input, int input_samples, float *const *output, int output_samples) {
    try {
        h->s.process(input, input_samples, output, output_samples);
        return 0;
    } catch (...) {
        return -1;
    }
}

int kss_flush(kss_handle *h, float *const *output, int output_samples) {
    try {
        h->s.flush(output, output_samples);
        return 0;
    } catch (...) {
        return -1;
    }
}

}  // extern "C"
