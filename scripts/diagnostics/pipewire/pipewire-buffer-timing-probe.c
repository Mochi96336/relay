#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/buffer/meta.h>
struct probe {struct pw_main_loop *loop; struct pw_stream *stream; uint64_t samples, last; unsigned count;};
static void process(void *data) {
 struct probe *p=data; struct pw_buffer *b;
 while ((b=pw_stream_dequeue_buffer(p->stream))) {
  struct pw_time t={0}; int rc=pw_stream_get_time_n(p->stream,&t,sizeof(t));
  uint64_t now=pw_stream_get_nsec(p->stream);
  struct spa_buffer *buf=b->buffer;
  uint32_t bytes=buf->n_datas && buf->datas[0].chunk ? buf->datas[0].chunk->size : 0;
  struct spa_meta_header *h=spa_buffer_find_meta_data(buf,SPA_META_Header,sizeof(*h));
  p->samples+=bytes/2; p->count++;
  if (!p->last || now-p->last>=250000000) {
   printf("{\"samples\":%"PRIu64",\"buffers\":%u,\"bytes\":%u,\"bufferTimeNs\":%"PRIu64",\"nowNs\":%"PRIu64",\"timingRc\":%d,\"timingNowNs\":%"PRId64",\"ticks\":%"PRIu64",\"rateNum\":%u,\"rateDenom\":%u,\"delay\":%"PRId64",\"queued\":%"PRIu64",\"buffered\":%"PRIu64",\"hasHeader\":%s,\"ptsNs\":%"PRId64",\"flags\":%u}\n",p->samples,p->count,bytes,b->time,now,rc,t.now,t.ticks,t.rate.num,t.rate.denom,t.delay,t.queued,t.buffered,h?"true":"false",h?h->pts:0,h?h->flags:0);
   fflush(stdout);p->last=now;
  }
  pw_stream_queue_buffer(p->stream,b);
  if(p->samples>=240000)pw_main_loop_quit(p->loop);
 }
}
static void state(void *data,enum pw_stream_state old,enum pw_stream_state state,const char *error){
 (void)old;struct probe *p=data;if(state==PW_STREAM_STATE_ERROR){fprintf(stderr,"stream error: %s\n",error);pw_main_loop_quit(p->loop);}
}
static const struct pw_stream_events events={PW_VERSION_STREAM_EVENTS,.state_changed=state,.process=process};
int main(int argc,char **argv){
 pw_init(&argc,&argv);struct probe p={0};p.loop=pw_main_loop_new(NULL);
 p.stream=pw_stream_new_simple(pw_main_loop_get_loop(p.loop),"relay-timestamp-probe",pw_properties_new(PW_KEY_MEDIA_TYPE,"Audio",PW_KEY_MEDIA_CATEGORY,"Capture",PW_KEY_MEDIA_ROLE,"Music",PW_KEY_TARGET_OBJECT,"relay_browser",PW_KEY_STREAM_CAPTURE_SINK,"true",NULL),&events,&p);
 uint8_t pod[1024];struct spa_pod_builder builder=SPA_POD_BUILDER_INIT(pod,sizeof(pod));
 struct spa_audio_info_raw info={.format=SPA_AUDIO_FORMAT_S16_LE,.rate=48000,.channels=1,.position={SPA_AUDIO_CHANNEL_MONO}};
 const struct spa_pod *params[]={spa_format_audio_raw_build(&builder,SPA_PARAM_EnumFormat,&info)};
 int rc=pw_stream_connect(p.stream,PW_DIRECTION_INPUT,PW_ID_ANY,PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS,params,1);
 if(rc<0){fprintf(stderr,"connect failed %d\n",rc);return 1;}
 pw_main_loop_run(p.loop);pw_stream_destroy(p.stream);pw_main_loop_destroy(p.loop);pw_deinit();return p.count?0:1;
}
