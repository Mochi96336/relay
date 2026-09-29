/*
 * Issue #493: isolated native *candidate* sidecar, NOT a replacement for
 * AudioSession. Consumes the exact positioned PCM written by the TS control.
 *
 * Invariant: the authoritative source start/end and every true gap are
 * independently calculated from manifest coordinates, NEVER from the count
 * of Speex output samples. The state is destroyed across every unproven
 * discontinuity. Samples inside the filter's startup latency are quarantined
 * rather than silently charged to a source/Takes.
 *
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror file.c -o program \
 *          $(pkg-config --cflags --libs speexdsp) -lm
 * Run: program OUTPUT_DIR/events.tsv OUTPUT_DIR > OUTPUT_DIR/native.ndjson
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <inttypes.h>
#include <speex/speex_resampler.h>

#define MIX_RATE 48000
#define MAX_LINE 1024
#define SAMPLES_MAX 100000

typedef struct {
    char scenario[96], source[16], reason[32];
    int gen, rate, ppm, group_index, changes, delay;
    int64_t first, end, received, produced;
    uint64_t hash;
    int64_t gap_source, gap_target;
    double ideal_dynamic_output;
} Group;
static SpeexResamplerState *state = NULL;
static Group group;
static int have_group = 0, group_index = 0, quality_mode = 5;

static void die(const char *message) {
    fprintf(stderr, "Speex positioned probe: %s\n", message);
    exit(2);
}
static int64_t target_ceil(int64_t src, int rate) {
    return (src * MIX_RATE + rate - 1) / rate;
}
static int init_rate(int rate, int ppm) {
    int error=RESAMPLER_ERR_SUCCESS;
    spx_uint32_t num=(spx_uint32_t)rate,den=MIX_RATE;
    if (ppm) {
        if (rate != MIX_RATE) die("ppm test deliberately limited to 48k capture");
        num=1000000;den=(spx_uint32_t)(1000000+ppm);
    }
    state=speex_resampler_init_frac(1,num,den,
        (spx_uint32_t)rate,(spx_uint32_t)MIX_RATE,
        quality_mode,&error);
    if (!state || error != RESAMPLER_ERR_SUCCESS) die("could not initialize fractional native SRC");
    return speex_resampler_get_output_latency(state);
}
static void set_dynamic_ratio(int ppm) {
    if (group.rate != MIX_RATE) die("dynamic ppm is not in 44.1k fixture");
    const int err=speex_resampler_set_rate_frac(state,1000000,
        (spx_uint32_t)(1000000+ppm),MIX_RATE,MIX_RATE);
    if (err != RESAMPLER_ERR_SUCCESS) die("set_rate_frac failed");
    group.ppm=ppm;
    group.changes++;
}
static void finalize_group(void) {
    if (!have_group) return;
    const int64_t start=target_ceil(group.first,group.rate);
    const int64_t end=target_ceil(group.end,group.rate);
    const int64_t expected=end-start;
    const int64_t usable=group.produced>group.delay ? group.produced-group.delay : 0;
    const int64_t shortfall=expected-usable;
    if (group.received != group.end-group.first) die("manifest source frontier mismatch");
    // For fixed-ratio segments, the remaining group delay must be explicit,
    // bounded debt. A valid output before the delay cannot be claimed.
    if (group.changes==0 && (shortfall < -4 || shortfall > group.delay+5)) {
        fprintf(stderr, "unexpected fixed-ratio shortfall=%" PRId64 " expected=%" PRId64
                        " produced=%" PRId64 " delay=%d\n",
            shortfall,expected,group.produced,group.delay);
        exit(3);
    }
    printf(
        "{\"scenario\":\"%s\",\"source\":\"%s\",\"group\":%d,\"quality\":%d,"
        "\"reason\":\"%s\",\"generation\":%d,\"rate\":%d,"
        "\"firstSource\":%" PRId64 ",\"endSource\":%" PRId64 ","
        "\"nominalFirstTarget\":%" PRId64 ",\"nominalEndTarget\":%" PRId64 ","
        "\"nominalTargetSpan\":%" PRId64 ",\"sourceSamples\":%" PRId64 ","
        "\"emittedSamples\":%" PRId64 ",\"filterLatencySamples\":%d,"
        "\"startupQuarantined\":%" PRId64 ",\"postLatencySamples\":%" PRId64 ","
        "\"unfilledTargetEstimate\":%" PRId64 ","
        "\"trueGapSourceSamples\":%" PRId64 ",\"trueGapTargetSamples\":%" PRId64 ","
        "\"ppmChanges\":%d,\"idealDynamicOutput\":%.5f,"
        "\"pcmHash\":\"%016" PRIx64 "\"}\n",
        group.scenario,group.source,group.group_index,quality_mode,group.reason,
        group.gen,group.rate,group.first,group.end,
        start,end,expected,group.received,group.produced,group.delay,
        group.produced<group.delay?group.produced:group.delay,
        usable,shortfall,group.gap_source,group.gap_target,
        group.changes,group.ideal_dynamic_output,group.hash);
    speex_resampler_destroy(state);
    state=NULL;have_group=0;
}
static void start_group(
    const char *scenario,const char *source,int gen,int rate,int ppm,
    int64_t first,const char *reason,int64_t gap_source,int64_t gap_target
) {
    memset(&group,0,sizeof(group));
    snprintf(group.scenario,sizeof(group.scenario),"%s",scenario);
    snprintf(group.source,sizeof(group.source),"%s",source);
    snprintf(group.reason,sizeof(group.reason),"%s",reason);
    group.gen=gen;group.rate=rate;group.ppm=ppm;
    group.first=first;group.end=first;
    group.gap_source=gap_source;group.gap_target=gap_target;
    group.group_index=group_index++;
    group.hash=UINT64_C(14695981039346656037);
    group.delay=init_rate(rate,ppm);
    have_group=1;
}
int main(int argc,char **argv) {
    if(argc<3||argc>4)die("usage: positioned-probe MANIFEST_TSV FIXTURE_ROOT [quality=5]");
    if(argc==4) {
        quality_mode=atoi(argv[3]);
        if(quality_mode!=3&&quality_mode!=5&&quality_mode!=8)
            die("research quality sweep only permits 3, 5, 8");
    }
    FILE *manifest=fopen(argv[1],"r");
    if(!manifest)die("cannot open manifest");
    char line[MAX_LINE],scenario[96],source[16],rel[256];
    int gen,rate,n,ppm;
    long long first;
    int64_t lastFirst=0,lastEnd=0;
    int lastRate=0,lastGen=0;
    char lastScenario[96]="",lastSource[16]="";
    while(fgets(line,sizeof(line),manifest)) {
        if(sscanf(line,"%95[^\t]\t%15[^\t]\t%d\t%d\t%lld\t%d\t%d\t%255s",
          scenario,source,&gen,&rate,&first,&n,&ppm,rel)!=8)
          die("malformed event TSV");
        if(n<1||n>SAMPLES_MAX||first<0||rate<8000||rate>192000||abs(ppm)>500)
          die("invalid manifest limits");
        const int sameCase=have_group&&strcmp(group.scenario,scenario)==0&&
          strcmp(group.source,source)==0;
        const int sameClock=sameCase&&gen==group.gen&&rate==group.rate;
        const int contiguous=sameClock&&(int64_t)first==group.end;
        if(!contiguous) {
            char reason[32]="initial";
            int64_t gap_src=0,gap_tgt=0;
            if(have_group) {
                if(!sameCase)snprintf(reason,sizeof(reason),"new-scenario");
                else if(gen!=group.gen)snprintf(reason,sizeof(reason),"generation");
                else if(rate!=group.rate)snprintf(reason,sizeof(reason),"rate");
                else {
                    if((int64_t)first<group.end)die("unclassified rewind inside the same capture");
                    snprintf(reason,sizeof(reason),"gap");
                    gap_src=(int64_t)first-group.end;
                    gap_tgt=target_ceil((int64_t)first,rate)-target_ceil(group.end,rate);
                }
                finalize_group();
            }
            start_group(scenario,source,gen,rate,ppm,(int64_t)first,
                reason,gap_src,gap_tgt);
            if(gap_src>0&&gap_tgt<1)die("positive source gap got no target position");
        } else if(ppm!=group.ppm) {
            set_dynamic_ratio(ppm);
        }
        // Consume the ACTUAL bytes generated by the real AudioSession
        // control fixture. No standalone sine synthesis or PCM substitution.
        char filename[1024];
        if(snprintf(filename,sizeof(filename),"%s/%s",argv[2],rel)>=
           (int)sizeof(filename))die("manifest path too long");
        FILE *input=fopen(filename,"rb");
        if(!input)die("missing source PCM file");
        spx_int16_t *raw=malloc((size_t)n*sizeof(*raw));
        spx_int16_t *out=malloc(((size_t)n*4+128)*sizeof(*out));
        if(!raw||!out)die("PCM allocation failed");
        if(fread(raw,sizeof(*raw),(size_t)n,input)!=(size_t)n)
          die("truncated source PCM");
        if(fgetc(input)!=EOF)die("unexpected trailing PCM");
        fclose(input);
        spx_uint32_t consumed=0;
        while(consumed<(spx_uint32_t)n) {
            spx_uint32_t in_len=(spx_uint32_t)n-consumed;
            spx_uint32_t out_len=(spx_uint32_t)n*4+128;
            const int e=speex_resampler_process_int(state,0,
                raw+consumed,&in_len,out,&out_len);
            if(e!=RESAMPLER_ERR_SUCCESS||(in_len==0&&out_len==0))
              die("native SRC stalled");
            consumed+=in_len;
            for(spx_uint32_t i=0;i<out_len;i++) {
                const uint16_t v=(uint16_t)out[i];
                group.hash^=(uint8_t)(v&0xff);group.hash*=UINT64_C(1099511628211);
                group.hash^=(uint8_t)(v>>8);group.hash*=UINT64_C(1099511628211);
            }
            group.produced+=out_len;
        }
        group.received+=n;
        group.end=(int64_t)first+n;
        group.ideal_dynamic_output+=(double)n*MIX_RATE/rate*(1.0+ppm/1e6);
        free(raw);free(out);
        lastFirst=(int64_t)first;lastEnd=(int64_t)first+n;
        lastRate=rate;lastGen=gen;
        snprintf(lastScenario,sizeof(lastScenario),"%s",scenario);
        snprintf(lastSource,sizeof(lastSource),"%s",source);
    }
    fclose(manifest);
    (void)lastFirst;(void)lastEnd;(void)lastRate;(void)lastGen;
    (void)lastScenario;(void)lastSource;
    finalize_group();
    return 0;
}
