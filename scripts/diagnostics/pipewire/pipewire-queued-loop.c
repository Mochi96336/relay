#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
struct app;
struct side{struct app *a;struct pw_stream *s;int output;};
struct app{struct pw_main_loop *loop;struct side out,in;uint64_t cursor;unsigned reads;};
static void process(void *data){
 struct side *s=data;struct app *a=s->a;struct pw_buffer *b;
 while((b=pw_stream_dequeue_buffer(s->s))){
  struct pw_time t={0};pw_stream_get_time_n(s->s,&t,sizeof(t));
  struct spa_data *d=&b->buffer->datas[0];uint32_t n;
  if(s->output){
   n=b->requested?b->requested:t.size;if(n>d->maxsize/2)n=d->maxsize/2;
   int16_t *pcm=d->data;uint64_t first=a->cursor;
   for(uint32_t i=0;i<n;i++)pcm[i]=1000+(a->cursor++%20000);
   d->chunk->offset=0;d->chunk->stride=2;d->chunk->size=n*2;b->size=n;
   printf("{\"side\":\"out\",\"time\":%"PRId64",\"ticks\":%"PRIu64",\"delay\":%"PRId64",\"queued\":%"PRIu64",\"buffered\":%"PRIu64",\"samples\":%u,\"first\":%"PRIu64"}\n",t.now,t.ticks,t.delay,t.queued,t.buffered,n,first);
  }else{
   n=d->chunk->size/2;int16_t *pcm=(int16_t*)((uint8_t*)d->data+d->chunk->offset);
   printf("{\"side\":\"in\",\"time\":%"PRIu64",\"now\":%"PRId64",\"ticks\":%"PRIu64",\"delay\":%"PRId64",\"samples\":%u,\"firstValue\":%d,\"lastValue\":%d}\n",b->time,t.now,t.ticks,t.delay,n,n?pcm[0]:0,n?pcm[n-1]:0);
   if(++a->reads>=40)pw_main_loop_quit(a->loop);
  }
  pw_stream_queue_buffer(s->s,b);
 }
}
static const struct pw_stream_events events={PW_VERSION_STREAM_EVENTS,.process=process};
static int connect_side(struct app *a,struct side *s,int output){
 s->a=a;s->output=output;
 s->s=pw_stream_new_simple(pw_main_loop_get_loop(a->loop),output?"relay-timing-stimulus":"relay-timing-check",pw_properties_new(PW_KEY_MEDIA_TYPE,"Audio",PW_KEY_MEDIA_CATEGORY,output?"Playback":"Capture",PW_KEY_TARGET_OBJECT,"relay_timestamp_test",PW_KEY_STREAM_CAPTURE_SINK,output?"false":"true",NULL),&events,s);
 uint8_t buf[1024];struct spa_pod_builder builder=SPA_POD_BUILDER_INIT(buf,sizeof(buf));
 struct spa_audio_info_raw info={.format=SPA_AUDIO_FORMAT_S16_LE,.rate=48000,.channels=1,.position={SPA_AUDIO_CHANNEL_MONO}};
 const struct spa_pod *p[]={spa_format_audio_raw_build(&builder,SPA_PARAM_EnumFormat,&info)};
 return pw_stream_connect(s->s,output?PW_DIRECTION_OUTPUT:PW_DIRECTION_INPUT,PW_ID_ANY,PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS,p,1);
}
int main(int argc,char **argv){pw_init(&argc,&argv);struct app a={0};a.loop=pw_main_loop_new(NULL);if(connect_side(&a,&a.in,0)<0||connect_side(&a,&a.out,1)<0)return 1;pw_main_loop_run(a.loop);pw_stream_destroy(a.in.s);pw_stream_destroy(a.out.s);pw_main_loop_destroy(a.loop);pw_deinit();return a.reads?0:1;}
