/* ==========================================================================
   library.js — your songs
   --------------------------------------------------------------------------
   One folder per song, named by `dir`. Everything else is derived:

     songs/<dir>/cover.jpg      artwork        (optional)
     songs/<dir>/vocals.mp3     isolated vocal stem
     songs/<dir>/backing.mp3    instrumental stem
     songs/<dir>/lyrics.lrc     [mm:ss.xx] timed lyrics

   To add a song: copy the files in, add one block below.
   Set `mix` if the stems are not already level-matched — vocals are usually
   quieter than the backing after stem separation. `backing` is the value that
   needs turning down to balance (see `tools/analyse-mix.py`).
   ========================================================================== */

window.LIBRARY = [

  {
    dir: 'baby',
    title: 'Baby',
    artist: 'Justin Bieber feat. Ludacris',
    album: 'My World 2.0',
    mix: { vocals: 1.00, backing: 0.51, master: 0.85 }
  },

  {
    dir: 'one-less-lonely-girl',
    title: 'One Less Lonely Girl',
    artist: 'Justin Bieber',
    album: 'My World',
    mix: { vocals: 1.00, backing: 0.71, master: 0.85 }
  },

  {
    dir: 'overboard',
    title: 'Overboard',
    artist: 'Justin Bieber feat. Chance the Rapper & Carly Rae Jepsen',
    album: 'Jackie Boy',
    mix: { vocals: 1.00, backing: 0.79, master: 0.85 }
  },

  {
    dir: 'that-should-be-me',
    title: 'That Should Be Me',
    artist: 'Justin Bieber feat. JY',
    album: 'My World 2.0',
    mix: { vocals: 1.00, backing: 0.76, master: 0.85 }
  },

  {
    dir: 'beauty-and-a-beat',
    title: 'Beauty and a Beat',
    artist: 'Justin Bieber feat. Nicki Minaj',
    album: 'Believe',
    mix: { vocals: 1.00, backing: 0.46, master: 0.85 }
  }

];