import socket
from _thread import start_new_thread

sock = None

def start():
  global sock
  if sock == None:
    start_new_thread(_start,())
  else:
    print('Already running')
     

def stop(reason = ''):
  global sock
  if sock != None:
    s = sock
    print('stop devweb', reason, s)
    sock = None  
    s.close()

def _start():
  global sock
  try:
    sock = socket.socket()
    addr = socket.getaddrinfo('0.0.0.0', 8267)[0][-1]
    sock.bind(addr)
    sock.listen(1)
    html = open('/more/www/devrepl-min.html.gz').read()
    print('devweb listening on', addr)
  
    while sock != None:
      cl, addr = sock.accept()
      try:
        cl_file = cl.makefile('rwb', 0)
        request = cl_file.readline().decode().split(' ')
        headers = {}
        while True:
          line = cl_file.readline()
          if not line or line == b'\r\n':
            break
          hdr = line.decode().split(':')
          headers[hdr[0].strip()] = hdr[1].strip()

        print('client requested', addr, request[1], headers['Accept-Encoding'])
        if 'gzip' in headers['Accept-Encoding']:
          if request[1]=='/':
            cl.send('HTTP/1.0 200 OK\r\nContent-type: text/html; charset=UTF-8\r\nContent-Encoding: gzip\r\n\r\n')
            cl.send(html)
          else:
            cl.send('HTTP/1.0 404 Not found\r\n\r\n')
        else:
          cl.send('HTTP/1.0 422 Must support gzip encoding\r\n\r\n')
        cl.close()
      except Exception as err:
          cl.send('HTTP/1.0 500\r\n\r\n'+str(err))

  except Exception as err:
    stop(err)
